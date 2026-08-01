import type { SupabaseClient } from "npm:@supabase/supabase-js@2.110.2";
import { generateLicenseKey, hashLicenseKey } from "./license.ts";

const FINAL_PAYMENT_STATUSES = ["refunded", "charged_back"];

export function effectiveProviderStatus(
  current: { status?: string | null; paid_at?: string | null },
  providerStatus: string,
): string {
  if (FINAL_PAYMENT_STATUSES.includes(String(current.status))) {
    return String(current.status);
  }
  if (FINAL_PAYMENT_STATUSES.includes(providerStatus)) {
    return providerStatus;
  }
  if (current.status === "approved" || current.paid_at) {
    return "approved";
  }
  if (providerStatus === "approved") {
    return "approved";
  }
  return providerStatus;
}

async function forceApplyProviderPaymentStatus(
  admin: SupabaseClient,
  input: {
    paymentId: string;
    providerPaymentId: string;
    status: string;
    raw: unknown;
  },
): Promise<string> {
  const { data: payment, error: readError } = await admin
    .from("payments")
    .select("id, status, paid_at, license_id, provider_payment_id")
    .eq("id", input.paymentId)
    .maybeSingle();
  if (readError) throw readError;
  if (!payment) throw new Error("Pagamento não encontrado ao reconciliar.");
  if (
    payment.provider_payment_id &&
    payment.provider_payment_id !== input.providerPaymentId
  ) {
    throw new Error("Pagamento retornado pelo provedor não corresponde ao checkout.");
  }

  const status = effectiveProviderStatus(payment, input.status);
  const { error: updateError } = await admin
    .from("payments")
    .update({
      status,
      provider_payment_id: input.providerPaymentId,
      raw: input.status === "approved" || status !== "approved" ? input.raw : undefined,
      paid_at: status === "approved" ? new Date().toISOString() : undefined,
    })
    .eq("id", input.paymentId);
  if (updateError) throw updateError;

  if (FINAL_PAYMENT_STATUSES.includes(status) && payment.license_id) {
    const { error } = await admin
      .from("licenses")
      .update({ status: "revoked" })
      .eq("id", payment.license_id)
      .neq("status", "revoked");
    if (error) throw error;
  } else if (status === "approved" && payment.license_id) {
    const { error } = await admin
      .from("licenses")
      .update({ status: "pending" })
      .eq("id", payment.license_id)
      .eq("status", "revoked")
      .is("activated_at", null);
    if (error) throw error;
  }

  return status;
}

function canFallbackToSingleLicenseRpc(error: { code?: string; message?: string }): boolean {
  const text = `${error.code ?? ""} ${error.message ?? ""}`;
  return /42883|finalize_approved_payment_bulk|function .* does not exist|schema cache/i.test(text);
}

async function finalizeSinglePaymentLicense(
  admin: SupabaseClient,
  paymentId: string,
): Promise<string[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = generateLicenseKey();
    const hash = await hashLicenseKey(key);
    const { data, error } = await admin.rpc("finalize_approved_payment", {
      p_payment_id: paymentId,
      p_license_key: key,
      p_license_key_hash: hash,
    });
    if (!error) return typeof data === "string" && data ? [data] : [];
    if (error.code !== "23505") throw error;
  }
  throw new Error("Não foi possível gerar uma chave única. Tente novamente.");
}

export async function applyProviderPaymentStatus(
  admin: SupabaseClient,
  input: {
    paymentId: string;
    providerPaymentId: string;
    status: string;
    raw: unknown;
  },
): Promise<string> {
  const { data, error } = await admin.rpc("apply_payment_status", {
    p_payment_id: input.paymentId,
    p_provider_payment_id: input.providerPaymentId,
    p_status: input.status,
    p_raw: input.raw,
  });
  if (error) {
    console.warn(
      "[payment-status:fallback]",
      JSON.stringify({
        paymentId: input.paymentId,
        providerPaymentId: input.providerPaymentId,
        status: input.status,
        message: error.message,
      }),
    );
    return forceApplyProviderPaymentStatus(admin, input);
  }
  if (typeof data !== "string") {
    throw new Error("Resposta inválida ao reconciliar pagamento.");
  }
  if (input.status === "approved" && data !== "approved") {
    console.warn(
      "[payment-status:override-approved]",
      JSON.stringify({
        paymentId: input.paymentId,
        providerPaymentId: input.providerPaymentId,
        rpcStatus: data,
      }),
    );
    return forceApplyProviderPaymentStatus(admin, input);
  }
  return data;
}

export async function finalizePaymentLicenses(
  admin: SupabaseClient,
  paymentId: string,
  quantity = 1,
): Promise<string[]> {
  const total = Math.max(1, Math.min(200, Math.floor(quantity) || 1));
  for (let attempt = 0; attempt < 5; attempt++) {
    const keys: { key: string; hash: string }[] = [];
    for (let i = 0; i < total; i++) {
      const key = generateLicenseKey();
      keys.push({ key, hash: await hashLicenseKey(key) });
    }
    const { data, error } = await admin.rpc("finalize_approved_payment_bulk", {
      p_payment_id: paymentId,
      p_keys: keys,
    });
    if (!error) {
      return Array.isArray(data) ? (data as string[]) : [];
    }
    if (canFallbackToSingleLicenseRpc(error)) {
      if (total !== 1) {
        throw new Error(
          "A função de geração em lote não está publicada no banco. Publique as migrations antes de vender múltiplas chaves.",
        );
      }
      console.warn(
        "[payment-finalize:single-fallback]",
        JSON.stringify({ paymentId, message: error.message }),
      );
      return finalizeSinglePaymentLicense(admin, paymentId);
    }
    if (error.code !== "23505") throw error;
  }
  throw new Error("Não foi possível gerar uma chave única. Tente novamente.");
}

export async function finalizePaymentIfApproved(
  admin: SupabaseClient,
  paymentId: string,
  quantity = 1,
): Promise<string | null> {
  const keys = await finalizePaymentLicenses(admin, paymentId, quantity);
  return keys[0] ?? null;
}


/**
 * Rede de segurança: reconsulta no Mercado Pago os Pix ainda pendentes e,
 * quando aprovados, aprova o pagamento e gera as chaves. Usado quando o
 * webhook falha ou nunca chega.
 */
export async function reconcilePendingPayments(
  admin: SupabaseClient,
  options: { userId?: string; limit?: number; sinceHours?: number } = {},
): Promise<number> {
  const { getPayment, assertMercadoPagoPaymentContract } = await import(
    "./mercadopago.ts"
  );
  const since = new Date(
    Date.now() - (options.sinceHours ?? 24 * 7) * 3600_000,
  ).toISOString();
  let query = admin
    .from("payments")
    .select(
      "id, user_id, quantity, amount_cents, buyer_email, provider_payment_id, status",
    )
    .in("status", [
      "pending",
      "in_process",
      "authorized",
      "in_mediation",
      // cancelado/rejeitado pode ser um evento fora de ordem de um Pix pago:
      // reconsultamos no provedor para não deixar cliente sem chave.
      "cancelled",
      "rejected",
    ])
    .not("provider_payment_id", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(Math.min(options.limit ?? 25, 100));
  if (options.userId) query = query.eq("user_id", options.userId);
  const { data, error } = await query;
  if (error || !data?.length) return 0;

  let approved = 0;
  for (const payment of data) {
    try {
      const remote = await getPayment(String(payment.provider_payment_id));
      const verified = assertMercadoPagoPaymentContract(remote, {
        paymentId: payment.id,
        providerPaymentId: payment.provider_payment_id,
        amountCents: payment.amount_cents,
        buyerEmail: payment.buyer_email,
      });
      const status = await applyProviderPaymentStatus(admin, {
        paymentId: payment.id,
        providerPaymentId: verified.providerId,
        status: verified.status,
        raw: remote,
      });
      if (status === "approved") {
        await finalizePaymentLicenses(admin, payment.id, payment.quantity ?? 1);
        approved += 1;
      }
    } catch (err) {
      console.warn(
        "[reconcile-payments]",
        JSON.stringify({
          paymentId: payment.id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Segunda rede: pagamentos já aprovados que ficaram sem chave gerada.
  let missing = admin
    .from("payments")
    .select("id, quantity")
    .eq("status", "approved")
    .is("license_id", null)
    .gte("created_at", since)
    .limit(50);
  if (options.userId) missing = missing.eq("user_id", options.userId);
  const { data: orphans } = await missing;
  for (const payment of orphans ?? []) {
    try {
      await finalizePaymentLicenses(admin, payment.id, payment.quantity ?? 1);
      approved += 1;
    } catch (err) {
      console.warn(
        "[reconcile-payments:orphan]",
        JSON.stringify({
          paymentId: payment.id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return approved;
}
