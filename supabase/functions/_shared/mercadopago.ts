import { ApiHttpError } from "./http.ts";

const MP_API = "https://api.mercadopago.com";
const PAYMENT_STATUSES = new Set([
  "pending",
  "approved",
  "authorized",
  "in_process",
  "in_mediation",
  "rejected",
  "cancelled",
  "refunded",
  "charged_back",
]);

function webhookSecret(): string | null {
  return Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET")?.trim() || null;
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyMercadoPagoWebhookSignature(
  request: Request,
  dataId: string,
): Promise<{ configured: boolean; valid: boolean }> {
  const secret = webhookSecret();
  if (!secret) return { configured: false, valid: true };

  const signature = request.headers.get("x-signature") ?? "";
  const requestId = request.headers.get("x-request-id") ?? "";
  const parts = new Map(
    signature.split(",").map((part) => {
      const [key, ...value] = part.trim().split("=");
      return [key, value.join("=")];
    }),
  );
  const timestamp = parts.get("ts") ?? "";
  const receivedHash = parts.get("v1")?.toLowerCase() ?? "";
  if (
    !timestamp || !requestId || !receivedHash ||
    !/^[0-9a-f]{64}$/.test(receivedHash)
  ) {
    return { configured: true, valid: false };
  }

  const manifest =
    `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(manifest),
  );
  const expectedHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    configured: true,
    valid: timingSafeEqualHex(expectedHash, receivedHash),
  };
}

function accessToken(): string {
  const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN")?.trim() ?? "";
  if (!token) {
    throw new Error("Token do Mercado Pago não configurado no Supabase.");
  }
  if (!token.startsWith("APP_USR-") && !token.startsWith("TEST-")) {
    throw new Error("Access Token do Mercado Pago inválido.");
  }
  return token;
}

export type VerifiedMercadoPagoPayment = {
  providerId: string;
  status: string;
};

export function assertMercadoPagoPaymentContract(
  remote: unknown,
  expected: {
    paymentId: string;
    providerPaymentId: string | null;
    amountCents: number;
    buyerEmail?: string | null;
  },
): VerifiedMercadoPagoPayment {
  const payment = remote && typeof remote === "object"
    ? remote as Record<string, unknown>
    : null;
  const providerId = payment?.id == null ? "" : String(payment.id);
  const status = payment?.status == null ? "" : String(payment.status);
  const externalReference = payment?.external_reference == null
    ? ""
    : String(payment.external_reference);
  const amount = Number(payment?.transaction_amount);
  const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
  const currency = payment?.currency_id == null
    ? ""
    : String(payment.currency_id);
  const method = payment?.payment_method_id == null
    ? ""
    : String(payment.payment_method_id);
  // Em Pix, o e-mail retornado pelo Mercado Pago pode vir mascarado ou como
  // o e-mail da conta pagadora, não necessariamente o e-mail do cadastro.
  // A amarração segura fica em provider id, external_reference, valor,
  // moeda e método de pagamento.
  const matches = providerId.length > 0 &&
    (!expected.providerPaymentId ||
      providerId === expected.providerPaymentId) &&
    externalReference === expected.paymentId &&
    amountCents === expected.amountCents &&
    currency === "BRL" &&
    method === "pix" &&
    PAYMENT_STATUSES.has(status);

  if (!matches) {
    throw new ApiHttpError(
      409,
      "PAYMENT_CONTRACT_MISMATCH",
      "O pagamento retornado pelo provedor não corresponde ao checkout.",
    );
  }
  return { providerId, status };
}

export function mercadoPagoIdentification(
  value?: string,
): { type: "CPF" | "CNPJ"; number: string } | null {
  const digits = (value ?? "").replace(/\D+/g, "");
  if (digits.length === 11) return { type: "CPF", number: digits };
  if (digits.length === 14) return { type: "CNPJ", number: digits };
  return null;
}

export async function createPixPayment(input: {
  amountCents: number;
  description: string;
  buyerName: string;
  buyerEmail: string;
  buyerWhatsapp?: string;
  buyerCpf?: string;
  externalReference: string;
  notificationUrl: string;
  idempotencyKey: string;
  expiresInMinutes?: number;
}) {
  const [firstName, ...rest] = (input.buyerName || "Cliente").trim().split(
    /\s+/,
  );
  const payer: Record<string, unknown> = {
    email: input.buyerEmail,
    first_name: firstName,
    last_name: rest.join(" ") || "Rise",
  };
  const identification = mercadoPagoIdentification(input.buyerCpf);
  if (identification) payer.identification = identification;
  const phone = (input.buyerWhatsapp ?? "").replace(/\D+/g, "");
  if (phone.length >= 10) {
    payer.phone = { area_code: phone.slice(0, 2), number: phone.slice(2) };
  }

  const expiration = new Date(
    Date.now() + (input.expiresInMinutes ?? 30) * 60_000,
  ).toISOString();
  const response = await fetch(`${MP_API}/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken()}`,
      "X-Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      transaction_amount: Number((input.amountCents / 100).toFixed(2)),
      description: input.description,
      payment_method_id: "pix",
      external_reference: input.externalReference,
      date_of_expiration: expiration,
      notification_url: input.notificationUrl,
      payer,
    }),
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Mercado Pago erro ${response.status}: ${payload?.message ?? "erro"}`,
    );
  }
  const transaction = payload?.point_of_interaction?.transaction_data ?? {};
  return {
    id: payload.id,
    status: payload.status,
    qr_code: transaction.qr_code ?? "",
    qr_code_base64: transaction.qr_code_base64 ?? "",
    ticket_url: transaction.ticket_url ?? null,
    date_of_expiration: payload.date_of_expiration ?? expiration,
    raw: payload,
  };
}

export async function getPayment(id: string | number): Promise<any> {
  const response = await fetch(
    `${MP_API}/v1/payments/${encodeURIComponent(String(id))}`,
    {
      headers: { Authorization: `Bearer ${accessToken()}` },
    },
  );
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Mercado Pago erro ${response.status}: ${payload?.message ?? "erro"}`,
    );
  }
  return payload;
}
