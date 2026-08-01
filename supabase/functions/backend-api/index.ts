import { z } from "npm:zod@3.25.76";
import {
  ApiHttpError,
  assertAllowedOrigin,
  createHttpContext,
  errorResponse,
  json,
  options,
  readJson,
} from "../_shared/http.ts";
import {
  assertRole,
  type AuthContext,
  getUserRoles,
  hasRole,
  requireUser,
} from "../_shared/supabase.ts";
import { generateLicenseKey, hashLicenseKey, insertUniqueLicense } from "../_shared/license.ts";
import {
  assertMercadoPagoPaymentContract,
  createPixPayment,
  getPayment,
} from "../_shared/mercadopago.ts";
import {
  applyProviderPaymentStatus,
  finalizePaymentIfApproved,
  finalizePaymentLicenses,
  reconcilePendingPayments,
} from "../_shared/payments.ts";
import { enforceRateLimit, sha256Hex } from "../_shared/rate-limit.ts";
import { deliverMarketplaceOrder } from "../_shared/marketplace.ts";

const ADMIN_ROLES = ["admin", "owner"];
const rangeSchema = z.object({
  from: z.string().datetime().optional().nullable(),
  to: z.string().datetime().optional().nullable(),
});
const planSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  duration_days: z.number().int().min(1).max(3650),
  price_cents: z.number().int().min(0),
  max_devices: z.number().int().min(1).max(50),
  is_active: z.boolean(),
  sort_order: z.number().int().min(0).max(999),
  features: z.array(z.string()).optional(),
});

function currentAal(claims: Record<string, unknown>): "aal1" | "aal2" {
  return claims.aal === "aal2" ? "aal2" : "aal1";
}

function assertAal2(claims: Record<string, unknown>) {
  if (currentAal(claims) !== "aal2") {
    throw new ApiHttpError(
      403,
      "MFA_REQUIRED",
      "Verificação em duas etapas exigida para acessar o painel administrativo.",
    );
  }
}

async function assertAdmin(context: AuthContext) {
  await assertRole(context.admin, context.userId, ADMIN_ROLES);
  assertAal2(context.claims);
  return context.userId;
}

const ADMIN_MUTATION_ACTIONS = new Set([
  "adminUpdateLicenseStatus",
  "adminGenerateLicenses",
  "adminDeleteLicense",
  "adminCreatePlan",
  "adminUpdatePlan",
  "adminSetUserRole",
  "adminDeleteUser",
  "createMarketplaceOrder",
  "adminCreateMarketplaceProduct",
  "adminUploadMarketplaceImage",
  "adminUpdateMarketplaceProduct",
  "adminDeleteMarketplaceProduct",
  "adminUpdateMarketplaceOrder",
]);

const BACKEND_ACTIONS = new Set([
  "getMyAccessContext",
  "claimResellerAccess",
  "getMyDashboard",
  "claimTrialLicense",
  "getAdminOverview",
  "adminUpdateLicenseStatus",
  "adminGenerateLicenses",
  "adminDeleteLicense",
  "adminCreatePlan",
  "adminUpdatePlan",
  "adminListUsers",
  "adminSetUserRole",
  "adminDeleteUser",
  "adminGetAuditLog",
  "adminListPayments",
  "getMyResellerInfo",
  "getResellerStats",
  "adminListResellers",
  "adminGetResellerDetail",
  "adminGetGlobalRevenue",
  "createPixCheckout",
  "getCheckoutStatus",
  "getAdminAccessStatus",
  "listMarketplaceProducts",
  "createMarketplaceOrder",
  "createMarketplacePixCheckout",
  "getMarketplaceOrderStatus",
  "listMyMarketplaceOrders",
  "adminListMarketplaceProducts",
  "adminCreateMarketplaceProduct",
  "adminUploadMarketplaceImage",
  "adminUpdateMarketplaceProduct",
  "adminDeleteMarketplaceProduct",
  "adminListMarketplaceOrders",
  "adminUpdateMarketplaceOrder",
]);

async function claimResellerAccess(context: AuthContext) {
  const roles = await getUserRoles(context.admin, context.userId);
  if (roles.includes("revendedor") || roles.includes("admin") || roles.includes("owner")) {
    return { ok: true, roles };
  }
  if (!context.email) {
    throw new ApiHttpError(400, "EMAIL_REQUIRED", "Sua conta não possui um email válido.");
  }
  const { data: claimed, error } = await context.admin.rpc("claim_reseller_entitlements", {
    p_user_id: context.userId,
    p_email: context.email,
  });
  if (error) throw error;
  if (claimed !== true) {
    throw new ApiHttpError(
      403,
      "RESELLER_PURCHASE_NOT_FOUND",
      "Esta conta não possui uma compra aprovada de acesso à revenda.",
    );
  }
  return {
    ok: true,
    roles: await getUserRoles(context.admin, context.userId),
  };
}

async function enforceBackendRateLimit(
  context: AuthContext,
  action: string,
  requestId: string,
): Promise<void> {
  const bucket =
    action === "createPixCheckout" || action === "createMarketplacePixCheckout"
      ? { scope: "backend-payment", limit: 10, windowSeconds: 600 }
      : ADMIN_MUTATION_ACTIONS.has(action)
        ? { scope: "backend-admin-mutation", limit: 60, windowSeconds: 60 }
        : { scope: "backend-general", limit: 180, windowSeconds: 60 };

  await enforceRateLimit(
    context.admin,
    bucket.scope,
    [context.userId, action],
    bucket.limit,
    bucket.windowSeconds,
    { requestId },
  );
}

function summarize(rows: any[]) {
  const paid = rows.filter((row) => row.status === "approved");
  return {
    total_sales: paid.length,
    total_amount_cents: paid.reduce((total, row) => total + (row.amount_cents ?? 0), 0),
    pending_count: rows.filter((row) => row.status === "pending").length,
    all_count: rows.length,
  };
}

function mapSales(rows: any[]) {
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    amount_cents: row.amount_cents,
    created_at: row.created_at,
    paid_at: row.paid_at,
    buyer_name: row.buyer_name,
    buyer_email: row.buyer_email,
    plan_name: row.plans?.name ?? null,
  }));
}

async function getMyAccessContext(context: AuthContext) {
  return {
    user: { id: context.userId, email: context.email },
    roles: await getUserRoles(context.admin, context.userId),
  };
}

async function getMyDashboard(context: AuthContext) {
  const { admin, userId } = context;
  // Rede de segurança: se o webhook falhou, aprova aqui e gera a chave.
  await reconcilePendingPayments(admin, { userId, limit: 10 });
  const [licensesResult, profileResult, trialClaimResult] = await Promise.all([
    admin
      .from("licenses")
      .select("*, plans(*)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    admin.from("profiles").select("*").eq("id", userId).maybeSingle(),
    admin.from("trial_license_claims").select("*, plans(*)").eq("user_id", userId).maybeSingle(),
  ]);
  if (licensesResult.error) throw licensesResult.error;
  if (profileResult.error) throw profileResult.error;
  if (trialClaimResult.error) throw trialClaimResult.error;
  const licenses = licensesResult.data ?? [];
  const trialClaim = trialClaimResult.data
    ? {
        ...trialClaimResult.data,
        status: trialClaimResult.data.license_status,
        is_deleted:
          !trialClaimResult.data.license_id ||
          !licenses.some((license) => license.id === trialClaimResult.data.license_id),
      }
    : null;
  const currentLicense =
    licenses.find((license) => license.status === "active") ??
    licenses.find((license) => license.status === "pending") ??
    licenses[0] ??
    null;
  let devices: any[] = [];
  let logs: any[] = [];
  if (currentLicense) {
    const [devicesResult, logsResult] = await Promise.all([
      admin.from("devices").select("*").eq("license_id", currentLicense.id),
      admin
        .from("activation_logs")
        .select("*")
        .eq("license_id", currentLicense.id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (devicesResult.error) throw devicesResult.error;
    if (logsResult.error) throw logsResult.error;
    devices = devicesResult.data ?? [];
    logs = logsResult.data ?? [];
  }
  return {
    profile: profileResult.data,
    licenses,
    currentLicense,
    trialClaim,
    devices,
    logs,
  };
}

async function claimTrialLicense(context: AuthContext) {
  const { admin, userId } = context;
  const { data: plan, error } = await admin.from("plans").select("*").eq("slug", "trial").single();
  if (error || !plan) throw new Error("Plano de teste não encontrado.");
  for (let attempt = 0; attempt < 5; attempt++) {
    const licenseKey = generateLicenseKey();
    const licenseKeyHash = await hashLicenseKey(licenseKey);
    const { data, error: claimError } = await admin.rpc("claim_trial_license", {
      p_user_id: userId,
      p_plan_id: plan.id,
      p_license_key: licenseKey,
      p_license_key_hash: licenseKeyHash,
      p_expires_at: null,
    });
    if (!claimError && data && typeof data === "object") {
      return data as { license: Record<string, unknown>; existed: boolean };
    }
    if (claimError?.code !== "23505") {
      throw claimError ?? new Error("Falha ao gerar licença de teste.");
    }
  }
  throw new Error("Não foi possível gerar uma chave única. Tente novamente.");
}

async function getAdminOverview(context: AuthContext) {
  await assertAdmin(context);
  const { admin } = context;
  const [licensesResult, profilesResult, usersResult, plansResult, logsResult] = await Promise.all([
    admin
      .from("licenses")
      .select("*, plans(name, slug)")
      .order("created_at", { ascending: false })
      .limit(500),
    admin.from("profiles").select("id, full_name, avatar_url"),
    admin.auth.admin.listUsers({ page: 1, perPage: 500 }),
    admin.from("plans").select("*").order("sort_order"),
    admin
      .from("activation_logs")
      .select("*")
      .order("created_at", {
        ascending: false,
      })
      .limit(50),
  ]);
  if (licensesResult.error) throw licensesResult.error;
  if (usersResult.error) throw usersResult.error;
  const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const emails = new Map(
    (usersResult.data.users ?? []).map((user) => [user.id, user.email ?? null]),
  );
  const licenses = (licensesResult.data ?? []).map((license) => ({
    ...license,
    profiles: license.user_id
      ? {
          full_name: profiles.get(license.user_id)?.full_name ?? null,
          email: emails.get(license.user_id) ?? null,
        }
      : null,
  }));
  return {
    counts: {
      active: licenses.filter((license) => license.status === "active").length,
      pending: licenses.filter((license) => license.status === "pending").length,
      expired: licenses.filter((license) => license.status === "expired").length,
      revoked: licenses.filter((license) => license.status === "revoked").length,
      suspended: licenses.filter((license) => license.status === "suspended").length,
      total_users: usersResult.data.users.length,
    },
    licenses,
    plans: plansResult.data ?? [],
    logs: logsResult.data ?? [],
  };
}

async function adminUpdateLicenseStatus(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = z
    .object({
      license_id: z.string().uuid(),
      status: z.enum(["active", "expired", "suspended", "revoked", "pending"]),
    })
    .parse(input);
  const patch: Record<string, unknown> = { status: data.status };
  if (data.status === "pending") {
    // Volta a chave para "não ativada": o tempo recomeça na próxima ativação.
    patch.activated_at = null;
    patch.expires_at = null;
  } else if (data.status === "active") {
    const { data: license, error: licenseError } = await context.admin
      .from("licenses")
      .select("*, plans(duration_days, duration_minutes)")
      .eq("id", data.license_id)
      .maybeSingle();
    if (licenseError) throw licenseError;
    if (!license) {
      throw new ApiHttpError(404, "LICENSE_NOT_FOUND", "Licença não encontrada.");
    }
    if (!license.expires_at) {
      const durationMs = license.custom_duration_seconds
        ? license.custom_duration_seconds * 1_000
        : license.custom_duration_minutes
          ? license.custom_duration_minutes * 60_000
          : license.plans?.duration_minutes
            ? license.plans.duration_minutes * 60_000
            : license.plans?.duration_days
              ? license.plans.duration_days * 86_400_000
              : 0;
      if (!durationMs) {
        throw new ApiHttpError(
          400,
          "INVALID_LICENSE_DURATION",
          "A licença não possui uma duração válida.",
        );
      }
      const now = Date.now();
      patch.activated_at = new Date(now).toISOString();
      patch.expires_at = new Date(now + durationMs).toISOString();
    }
  }
  const { data: updated, error } = await context.admin
    .from("licenses")
    .update(patch)
    .eq("id", data.license_id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!updated) {
    throw new ApiHttpError(404, "LICENSE_NOT_FOUND", "Licença não encontrada.");
  }
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "update_license_status",
    target_type: "license",
    target_id: data.license_id,
    details: { new_status: data.status },
  });
  return { ok: true };
}

async function adminGenerateLicenses(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = z
    .object({
      plan_slug: z.string().min(1).optional().nullable(),
      count: z.number().int().min(1).max(100),
      email: z.string().email().optional().nullable(),
      notes: z.string().max(500).optional().nullable(),
      custom_duration_minutes: z
        .number()
        .int()
        .min(1)
        .max(60 * 24 * 3650)
        .optional()
        .nullable(),
      custom_duration_seconds: z
        .number()
        .int()
        .min(1)
        .max(60 * 60 * 24 * 3650)
        .optional()
        .nullable(),
      max_devices_override: z.number().int().min(1).max(50).optional().nullable(),
    })
    .refine(
      (value) =>
        !!value.plan_slug || !!value.custom_duration_minutes || !!value.custom_duration_seconds,
    )
    .parse(input);
  let planId: string | null = null;
  if (data.plan_slug) {
    const { data: plan, error } = await context.admin
      .from("plans")
      .select("id")
      .eq("slug", data.plan_slug)
      .single();
    if (error || !plan) throw new Error("Plano não encontrado.");
    planId = plan.id;
  }
  let targetUserId: string | null = null;
  if (data.email) {
    const { data: users, error } = await context.admin.auth.admin.listUsers({
      page: 1,
      perPage: 500,
    });
    if (error) throw error;
    targetUserId =
      users.users.find((user) => user.email?.toLowerCase() === data.email?.toLowerCase())?.id ??
      null;
    if (!targetUserId) {
      throw new Error(`Usuário com email ${data.email} não encontrado.`);
    }
  }
  const licenses = [];
  for (let index = 0; index < data.count; index++) {
    licenses.push(
      await insertUniqueLicense(context.admin, {
        user_id: targetUserId,
        plan_id: planId,
        status: "pending",
        notes: data.notes ?? null,
        custom_duration_minutes: data.custom_duration_minutes ?? null,
        custom_duration_seconds: data.custom_duration_seconds ?? null,
        max_devices_override: data.max_devices_override ?? null,
      }),
    );
  }
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "generate_licenses",
    target_type: "license",
    details: { ...data, count: licenses.length },
  });
  return { licenses };
}

async function adminDeleteLicense(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = z.object({ license_id: z.string().uuid() }).parse(input);
  const { error } = await context.admin.from("licenses").delete().eq("id", data.license_id);
  if (error) throw error;
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "delete_license",
    target_type: "license",
    target_id: data.license_id,
  });
  return { ok: true };
}

async function adminCreatePlan(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = planSchema.parse(input);
  const { data: plan, error } = await context.admin
    .from("plans")
    .insert({ ...data, features: data.features ?? [] })
    .select()
    .single();
  if (error) throw error;
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "create_plan",
    target_type: "plan",
    target_id: plan.id,
    details: data,
  });
  return { plan };
}

async function adminUpdatePlan(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = planSchema.extend({ id: z.string().uuid() }).parse(input);
  const { id, ...updates } = data;
  const { data: plan, error } = await context.admin
    .from("plans")
    .update({ ...updates, features: updates.features ?? [] })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "update_plan",
    target_type: "plan",
    target_id: id,
    details: updates,
  });
  return { plan };
}

async function adminListUsers(context: AuthContext) {
  await assertAdmin(context);
  const [usersResult, profilesResult, rolesResult, licensesResult] = await Promise.all([
    context.admin.auth.admin.listUsers({ page: 1, perPage: 500 }),
    context.admin.from("profiles").select("*"),
    context.admin.from("user_roles").select("*"),
    context.admin.from("licenses").select("user_id, status"),
  ]);
  if (usersResult.error) throw usersResult.error;
  const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const roles = new Map<string, string[]>();
  for (const role of rolesResult.data ?? []) {
    roles.set(role.user_id, [...(roles.get(role.user_id) ?? []), role.role]);
  }
  const licenseCounts = new Map<string, number>();
  for (const license of licensesResult.data ?? []) {
    if (license.user_id) {
      licenseCounts.set(license.user_id, (licenseCounts.get(license.user_id) ?? 0) + 1);
    }
  }
  return usersResult.data.users.map((user) => ({
    id: user.id,
    email: user.email ?? null,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at ?? null,
    full_name: profiles.get(user.id)?.full_name ?? null,
    avatar_url: profiles.get(user.id)?.avatar_url ?? null,
    roles: roles.get(user.id) ?? [],
    license_count: licenseCounts.get(user.id) ?? 0,
  }));
}

async function adminSetUserRole(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = z
    .object({
      user_id: z.string().uuid(),
      role: z.enum(["admin", "user", "cliente", "revendedor", "owner"]),
      action: z.enum(["grant", "revoke"]),
    })
    .parse(input);
  if (["admin", "owner"].includes(data.role)) {
    const callerIsOwner = await hasRole(context.admin, adminId, "owner");
    if (!callerIsOwner) {
      throw new ApiHttpError(
        403,
        "OWNER_REQUIRED",
        "Somente um owner pode conceder ou remover acesso administrativo.",
      );
    }
  }
  if (
    data.user_id === adminId &&
    ["admin", "owner"].includes(data.role) &&
    data.action === "revoke"
  ) {
    throw new ApiHttpError(
      403,
      "SELF_ROLE_CHANGE_FORBIDDEN",
      "Você não pode remover seu próprio acesso de admin/owner.",
    );
  }
  if (data.action === "grant") {
    const { error } = await context.admin
      .from("user_roles")
      .insert({ user_id: data.user_id, role: data.role });
    if (error && !/duplicate|unique/i.test(error.message)) throw error;
  } else {
    const { error } = await context.admin
      .from("user_roles")
      .delete()
      .eq("user_id", data.user_id)
      .eq("role", data.role);
    if (error) throw error;
  }
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: `${data.action}_role`,
    target_type: "user",
    target_id: data.user_id,
    details: { role: data.role },
  });
  return { ok: true };
}

async function adminDeleteUser(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = z.object({ user_id: z.string().uuid() }).parse(input);
  if (data.user_id === adminId) {
    throw new ApiHttpError(
      403,
      "SELF_DELETE_FORBIDDEN",
      "Você não pode excluir sua própria conta.",
    );
  }
  const targetRoles = await getUserRoles(context.admin, data.user_id);
  if (targetRoles.some((role) => ADMIN_ROLES.includes(role))) {
    const callerIsOwner = await hasRole(context.admin, adminId, "owner");
    if (!callerIsOwner) {
      throw new ApiHttpError(
        403,
        "OWNER_REQUIRED",
        "Somente um owner pode excluir outro administrador.",
      );
    }
  }
  const { error } = await context.admin.auth.admin.deleteUser(data.user_id);
  if (error) throw error;
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "delete_user",
    target_type: "user",
    target_id: data.user_id,
    details: {},
  });
  return { ok: true };
}

async function adminGetAuditLog(context: AuthContext) {
  await assertAdmin(context);
  const { data, error } = await context.admin
    .from("admin_audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

async function adminListPayments(context: AuthContext) {
  await assertAdmin(context);
  // Reconcilia pendentes antes de listar: nada fica "pendente" se já foi pago.
  await reconcilePendingPayments(context.admin, { limit: 40 });
  const { data, error } = await context.admin
    .from("payments")
    .select(
      "id, status, amount_cents, buyer_name, buyer_whatsapp, buyer_email, provider_payment_id, paid_at, expires_at, created_at, plans(name, slug), licenses(license_key)",
    )
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return data ?? [];
}

async function getMyResellerInfo(context: AuthContext) {
  await assertRole(context.admin, context.userId, "revendedor");
  const profileResult = await context.admin
    .from("profiles")
    .select("id, full_name, referral_code")
    .eq("id", context.userId)
    .maybeSingle();
  if (profileResult.error) throw profileResult.error;
  let profile = profileResult.data;
  if (!profile?.referral_code) {
    const generated = await context.admin.rpc("generate_referral_code", {
      _user_id: context.userId,
    });
    if (generated.error) throw generated.error;
    const refreshed = await context.admin
      .from("profiles")
      .select("id, full_name, referral_code")
      .eq("id", context.userId)
      .single();
    if (refreshed.error) throw refreshed.error;
    profile = refreshed.data;
  }
  return {
    referral_code: profile?.referral_code ?? null,
    full_name: profile?.full_name ?? null,
  };
}

async function getResellerStats(context: AuthContext, input: unknown) {
  await assertRole(context.admin, context.userId, "revendedor");
  const range = rangeSchema.parse(input);
  let query = context.admin
    .from("payments")
    .select("id, status, amount_cents, created_at, paid_at, buyer_name, buyer_email, plans(name)")
    .eq("reseller_id", context.userId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lte("created_at", range.to);
  const { data, error } = await query;
  if (error) throw error;
  const sales = mapSales(data ?? []);
  return { sales, summary: summarize(sales) };
}

async function adminListResellers(context: AuthContext, input: unknown) {
  await assertAdmin(context);
  const range = rangeSchema.parse(input);
  const { data: roles, error } = await context.admin
    .from("user_roles")
    .select("user_id")
    .eq("role", "revendedor");
  if (error) throw error;
  const resellerIds = (roles ?? []).map((role) => role.user_id);
  if (!resellerIds.length) {
    return {
      resellers: [],
      global: { total_amount_cents: 0, total_sales: 0, pending_count: 0 },
    };
  }

  let paymentsQuery = context.admin
    .from("payments")
    .select("reseller_id, status, amount_cents, created_at")
    .in("reseller_id", resellerIds);
  if (range.from) paymentsQuery = paymentsQuery.gte("created_at", range.from);
  if (range.to) paymentsQuery = paymentsQuery.lte("created_at", range.to);
  const [profilesResult, usersResult, paymentsResult] = await Promise.all([
    context.admin.from("profiles").select("id, full_name, referral_code").in("id", resellerIds),
    context.admin.auth.admin.listUsers({ page: 1, perPage: 500 }),
    paymentsQuery,
  ]);
  if (usersResult.error) throw usersResult.error;
  if (paymentsResult.error) throw paymentsResult.error;
  const emails = new Map(usersResult.data.users.map((user) => [user.id, user.email ?? null]));
  const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const totals = new Map(resellerIds.map((id) => [id, { paid: 0, paidCents: 0, pending: 0 }]));
  let globalPaidCents = 0;
  let globalPaid = 0;
  let globalPending = 0;
  for (const payment of paymentsResult.data ?? []) {
    const bucket = totals.get(payment.reseller_id);
    if (!bucket) continue;
    if (payment.status === "approved") {
      bucket.paid++;
      bucket.paidCents += payment.amount_cents ?? 0;
      globalPaid++;
      globalPaidCents += payment.amount_cents ?? 0;
    } else if (payment.status === "pending") {
      bucket.pending++;
      globalPending++;
    }
  }
  const resellers = resellerIds
    .map((id) => ({
      user_id: id,
      email: emails.get(id) ?? null,
      full_name: profiles.get(id)?.full_name ?? null,
      referral_code: profiles.get(id)?.referral_code ?? null,
      total_sales: totals.get(id)?.paid ?? 0,
      total_amount_cents: totals.get(id)?.paidCents ?? 0,
      pending_count: totals.get(id)?.pending ?? 0,
    }))
    .sort((a, b) => b.total_amount_cents - a.total_amount_cents);
  return {
    resellers,
    global: {
      total_amount_cents: globalPaidCents,
      total_sales: globalPaid,
      pending_count: globalPending,
    },
  };
}

async function adminGetResellerDetail(context: AuthContext, input: unknown) {
  await assertAdmin(context);
  const range = rangeSchema.extend({ user_id: z.string().uuid() }).parse(input);
  let query = context.admin
    .from("payments")
    .select("id, status, amount_cents, created_at, paid_at, buyer_name, buyer_email, plans(name)")
    .eq("reseller_id", range.user_id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lte("created_at", range.to);
  const { data, error } = await query;
  if (error) throw error;
  const sales = mapSales(data ?? []);
  return { sales, summary: summarize(sales) };
}

async function adminGetGlobalRevenue(context: AuthContext, input: unknown) {
  await assertAdmin(context);
  const range = rangeSchema.parse(input);
  let query = context.admin
    .from("payments")
    .select("status, amount_cents, reseller_id, created_at");
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lte("created_at", range.to);
  const { data, error } = await query;
  if (error) throw error;
  const totals = {
    total_amount_cents: 0,
    total_sales: 0,
    pending_count: 0,
    via_reseller_amount_cents: 0,
    via_reseller_sales: 0,
    direct_amount_cents: 0,
    direct_sales: 0,
  };
  for (const payment of data ?? []) {
    if (payment.status === "pending") totals.pending_count++;
    if (payment.status !== "approved") continue;
    totals.total_amount_cents += payment.amount_cents ?? 0;
    totals.total_sales++;
    if (payment.reseller_id) {
      totals.via_reseller_amount_cents += payment.amount_cents ?? 0;
      totals.via_reseller_sales++;
    } else {
      totals.direct_amount_cents += payment.amount_cents ?? 0;
      totals.direct_sales++;
    }
  }
  return totals;
}

const RESELLER_WHOLESALE_CENTS: Record<string, number> = {
  weekly: 1490,
  monthly: 2990,
  lifetime: 14990,
};
const RESELLER_WEEK_CENTS = 1490;
const RESELLER_MONTH_CENTS = 2990;
const RESELLER_LIFETIME_CENTS = 14990;
const RESELLER_MIN_ORDER_CENTS = 990;

/** Mesma tabela usada no painel de revenda (KeyStore.tsx). */
function resellerCustomPriceCents(days: number): number {
  const d = Math.max(1, Math.floor(days) || 1);
  let cents: number;
  if (d <= 7) {
    cents = (RESELLER_WEEK_CENTS / 7) * d;
  } else if (d <= 30) {
    cents = RESELLER_WEEK_CENTS + ((RESELLER_MONTH_CENTS - RESELLER_WEEK_CENTS) / 23) * (d - 7);
  } else {
    cents = RESELLER_MONTH_CENTS + 100 * (d - 30);
  }
  cents = Math.min(RESELLER_LIFETIME_CENTS, Math.max(RESELLER_MIN_ORDER_CENTS, cents));
  return Math.ceil(cents / 10) * 10;
}

async function createPixCheckout(context: AuthContext, input: unknown) {
  const data = z
    .object({
      plan_slug: z.string().min(2).max(50),
      buyer_name: z.string().min(2).max(120),
      buyer_whatsapp: z.string().min(8).max(30),
      buyer_cpf: z.string().max(20).optional(),
      referral_code: z.string().min(4).max(16).optional().nullable(),
      idempotency_key: z.string().uuid(),
      reseller: z.boolean().optional(),
      quantity: z.number().int().min(1).max(200).optional(),
      custom_duration_days: z.number().int().min(1).max(3650).optional().nullable(),
    })
    .parse(input);

  const isResellerOrder = data.reseller === true;
  const quantity = isResellerOrder ? (data.quantity ?? 1) : 1;
  const customDays = isResellerOrder ? (data.custom_duration_days ?? null) : null;

  if (isResellerOrder) {
    const roles = await getUserRoles(context.admin, context.userId);
    const allowed = roles.some((role) => role === "revendedor" || ADMIN_ROLES.includes(role));
    if (!allowed) {
      throw new ApiHttpError(
        403,
        "RESELLER_ONLY",
        "Apenas revendedores podem comprar licenças no atacado.",
      );
    }
    if (!customDays && !(data.plan_slug in RESELLER_WHOLESALE_CENTS)) {
      throw new ApiHttpError(400, "INVALID_RESELLER_PLAN", "Plano indisponível para revenda.");
    }
  }

  const planSlug = isResellerOrder && customDays ? "monthly" : data.plan_slug;
  const { data: plan, error } = await context.admin
    .from("plans")
    .select("*")
    .eq("slug", planSlug)
    .eq("is_active", true)
    .single();
  if (error || !plan) throw new Error("Plano não encontrado.");

  const unitPriceCents = isResellerOrder
    ? customDays
      ? resellerCustomPriceCents(customDays)
      : RESELLER_WHOLESALE_CENTS[data.plan_slug]
    : plan.price_cents;
  const amountCents = unitPriceCents * quantity;

  if (amountCents <= 0) {
    throw new ApiHttpError(
      400,
      "PAYMENT_NOT_REQUIRED",
      "Este plano é gratuito e não requer pagamento.",
    );
  }

  if (!context.email) {
    throw new ApiHttpError(
      400,
      "USER_EMAIL_REQUIRED",
      "E-mail do usuário não encontrado. Faça login novamente.",
    );
  }
  const digits = (value: string) => value.replace(/\D+/g, "");
  const normalizedBuyerName = data.buyer_name.trim().replace(/\s+/g, " ");
  const normalizedBuyerWhatsapp = digits(data.buyer_whatsapp);
  const normalizedBuyerCpf = digits(data.buyer_cpf ?? "");
  let resellerId: string | null = null;
  if (data.referral_code) {
    const code = data.referral_code.toUpperCase().trim();
    const { data: profile } = await context.admin
      .from("profiles")
      .select("id")
      .eq("referral_code", code)
      .maybeSingle();
    if (
      profile &&
      profile.id !== context.userId &&
      (await hasRole(context.admin, profile.id, "revendedor"))
    ) {
      resellerId = profile.id;
    }
  }
  const requestFingerprint = await sha256Hex(
    JSON.stringify({
      planId: plan.id,
      buyerName: normalizedBuyerName,
      buyerWhatsapp: normalizedBuyerWhatsapp,
      buyerCpf: normalizedBuyerCpf,
      buyerEmail: context.email.trim().toLowerCase(),
      resellerId,
      quantity,
      customDays,
      amountCents,
    }),
  );
  const existingResult = await context.admin
    .from("payments")
    .select("*")
    .eq("user_id", context.userId)
    .eq("client_request_id", data.idempotency_key)
    .maybeSingle();
  if (existingResult.error) throw existingResult.error;

  let payment = existingResult.data;
  if (!payment) {
    const inserted = await context.admin
      .from("payments")
      .insert({
        plan_id: plan.id,
        user_id: context.userId,
        reseller_id: resellerId,
        client_request_id: data.idempotency_key,
        request_fingerprint: requestFingerprint,
        amount_cents: amountCents,
        quantity,
        custom_duration_days: customDays,
        buyer_name: normalizedBuyerName,
        buyer_whatsapp: normalizedBuyerWhatsapp,
        buyer_email: context.email,
        status: "pending",
      })
      .select()
      .single();

    if (inserted.error?.code === "23505") {
      const raced = await context.admin
        .from("payments")
        .select("*")
        .eq("user_id", context.userId)
        .eq("client_request_id", data.idempotency_key)
        .single();
      if (raced.error) throw raced.error;
      payment = raced.data;
    } else {
      if (inserted.error || !inserted.data) {
        throw inserted.error ?? new Error("Falha ao criar pagamento.");
      }
      payment = inserted.data;
    }
  }

  const legacyRequestMatches =
    payment.plan_id === plan.id &&
    payment.buyer_name === normalizedBuyerName &&
    payment.buyer_whatsapp === normalizedBuyerWhatsapp &&
    payment.buyer_email?.trim().toLowerCase() === context.email.trim().toLowerCase() &&
    payment.reseller_id === resellerId;
  if (
    (payment.request_fingerprint && payment.request_fingerprint !== requestFingerprint) ||
    (!payment.request_fingerprint && !legacyRequestMatches)
  ) {
    throw new ApiHttpError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Esta tentativa de pagamento já foi usada com outros dados. Inicie um novo checkout.",
    );
  }
  if (!payment.request_fingerprint && !payment.provider_payment_id) {
    throw new ApiHttpError(
      409,
      "IDEMPOTENCY_RETRY_REQUIRED",
      "Não foi possível confirmar a tentativa anterior. Inicie um novo checkout.",
    );
  }

  const orderLabel = isResellerOrder
    ? `Rise Lovable — ${quantity}x ${
        customDays ? `chave de ${customDays} dia(s)` : plan.name
      } (revenda)`
    : `Rise Lovable — ${plan.name}`;

  if (payment.provider_payment_id && payment.qr_code) {
    return {
      payment_id: payment.id,
      status: payment.status,
      qr_code: payment.qr_code,
      qr_code_base64: payment.qr_code_base64,
      ticket_url: payment.ticket_url,
      expires_at: payment.expires_at,
      amount_cents: payment.amount_cents,
      plan_name: orderLabel,
    };
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
    if (!supabaseUrl) throw new Error("SUPABASE_URL não configurada.");
    const pix = await createPixPayment({
      amountCents: payment.amount_cents,
      description: orderLabel,
      buyerName: payment.buyer_name,
      buyerEmail: context.email,
      buyerWhatsapp: payment.buyer_whatsapp ?? undefined,
      buyerCpf: normalizedBuyerCpf || undefined,
      externalReference: payment.id,
      notificationUrl: `${supabaseUrl}/functions/v1/mercadopago-webhook`,
      idempotencyKey: payment.id,
      expiresInMinutes: 30,
    });
    const verified = assertMercadoPagoPaymentContract(pix.raw, {
      paymentId: payment.id,
      providerPaymentId: payment.provider_payment_id,
      amountCents: payment.amount_cents,
      buyerEmail: payment.buyer_email,
    });
    const effectiveStatus = await applyProviderPaymentStatus(context.admin, {
      paymentId: payment.id,
      providerPaymentId: verified.providerId,
      status: verified.status,
      raw: pix.raw,
    });
    const { error: updateError } = await context.admin
      .from("payments")
      .update({
        qr_code: pix.qr_code,
        qr_code_base64: pix.qr_code_base64,
        ticket_url: pix.ticket_url,
        expires_at: pix.date_of_expiration,
      })
      .eq("id", payment.id);
    if (updateError) throw updateError;
    if (effectiveStatus === "approved") {
      await finalizePaymentIfApproved(context.admin, payment.id, quantity);
    }
    return {
      payment_id: payment.id,
      status: effectiveStatus,
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      ticket_url: pix.ticket_url,
      expires_at: pix.date_of_expiration,
      amount_cents: payment.amount_cents,
      plan_name: orderLabel,
    };
  } catch (error) {
    await context.admin
      .from("payments")
      .update({
        status: "error",
        raw: { error: error instanceof Error ? error.message : String(error) },
      })
      .eq("id", payment.id)
      .eq("status", "pending")
      .is("provider_payment_id", null);
    throw error;
  }
}

async function getCheckoutStatus(context: AuthContext, input: unknown) {
  const data = z.object({ payment_id: z.string().uuid() }).parse(input);
  const { data: payment, error } = await context.admin
    .from("payments")
    .select("*, plans(*), licenses(license_key)")
    .eq("id", data.payment_id)
    .maybeSingle();
  if (error || !payment) throw new Error("Pagamento não encontrado.");
  if (payment.user_id !== context.userId) {
    throw new ApiHttpError(403, "FORBIDDEN", "Acesso negado.");
  }
  if (payment.provider_payment_id) {
    let remote: unknown = null;
    try {
      remote = await getPayment(payment.provider_payment_id);
    } catch {
      console.warn(
        "[payment-poll]",
        JSON.stringify({
          code: "PROVIDER_FETCH_FAILED",
          paymentId: payment.id,
        }),
      );
    }
    if (remote) {
      const verified = assertMercadoPagoPaymentContract(remote, {
        paymentId: payment.id,
        providerPaymentId: payment.provider_payment_id,
        amountCents: payment.amount_cents,
        buyerEmail: payment.buyer_email,
      });
      payment.status = await applyProviderPaymentStatus(context.admin, {
        paymentId: payment.id,
        providerPaymentId: verified.providerId,
        status: verified.status,
        raw: remote,
      });
    }
  }
  const quantity = payment.quantity ?? 1;
  let licenseKeys: string[] = [];
  if (payment.status === "approved") {
    licenseKeys = await finalizePaymentLicenses(context.admin, payment.id, quantity);
  }
  return {
    status: payment.status,
    license_key: licenseKeys[0] ?? null,
    license_keys: licenseKeys,
    quantity,
    plan_name: payment.plans?.name ?? null,
    expires_at: payment.expires_at,
  };
}

async function getAdminAccessStatus(context: AuthContext) {
  const roles = await getUserRoles(context.admin, context.userId);
  const isAdmin = roles.some((role) => ADMIN_ROLES.includes(role));
  const role = roles.includes("owner")
    ? "owner"
    : roles.includes("admin")
      ? "admin"
      : (roles[0] ?? null);

  if (!isAdmin) {
    return {
      isAdmin: false,
      role,
      roles,
      hasTotp: false,
      currentAal: currentAal(context.claims),
    };
  }

  const factorsResult = await context.admin.auth.admin.mfa.listFactors({
    userId: context.userId,
  });
  if (factorsResult.error) throw factorsResult.error;
  const hasTotp = (factorsResult.data.factors ?? []).some(
    (factor: any) => factor.factor_type === "totp" && factor.status === "verified",
  );

  return {
    isAdmin: true,
    role,
    roles,
    hasTotp,
    currentAal: currentAal(context.claims),
  };
}

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v == null || v.trim() === "" ? null : v));

const productSchema = z.object({
  slug: z
    .string()
    .min(2, "Use ao menos 2 caracteres.")
    .max(60)
    .regex(/^[a-z0-9_-]+$/, "Use apenas letras minúsculas, números, - e _."),
  name: z.string().min(1, "Informe o nome.").max(120),
  tagline: optionalText(200),
  description: optionalText(4000),
  category: z.string().min(1, "Informe a categoria.").max(40),
  price_cents: z.coerce.number().int().min(0).max(100_000_000),
  old_price_cents: z.coerce.number().int().min(0).max(100_000_000).optional().nullable(),
  cover_url: z
    .string()
    .max(1_500_000, "A imagem excede o limite permitido.")
    .refine((value) => {
      if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(value)) {
        return true;
      }
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    }, "Envie uma imagem válida ou uma URL http(s).")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  delivery_type: z.enum(["link", "text", "file", "manual"]),
  delivery_content: optionalText(20_000),
  delivery_instructions: optionalText(4000),
  stock: z.coerce.number().int().min(0).max(1_000_000).optional().nullable(),
  stock_items: z.array(z.string().min(1).max(20_000)).max(5_000).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  is_active: z.boolean(),
  featured: z.boolean(),
  sort_order: z.coerce.number().int().min(0).max(999),
});

function publicProduct(row: any) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    category: row.category,
    price_cents: row.price_cents,
    old_price_cents: row.old_price_cents,
    cover_url: row.cover_url,
    delivery_type: row.delivery_type,
    delivery_instructions: row.delivery_instructions,
    stock: row.stock,
    rating: Number(row.rating ?? 5),
    featured: row.featured,
  };
}

async function listMarketplaceProducts(context: AuthContext) {
  const { data, error } = await context.admin
    .from("marketplace_products")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { products: (data ?? []).map(publicProduct) };
}

async function createMarketplaceOrder(context: AuthContext, input: unknown) {
  const data = z
    .object({
      product_id: z.string().uuid(),
      buyer_note: z.string().max(500).optional().nullable(),
    })
    .parse(input);

  const { data: product, error } = await context.admin
    .from("marketplace_products")
    .select("*")
    .eq("id", data.product_id)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!product) {
    throw new ApiHttpError(404, "PRODUCT_NOT_FOUND", "Produto indisponível.");
  }
  if (product.stock !== null && product.stock <= 0) {
    throw new ApiHttpError(409, "OUT_OF_STOCK", "Produto esgotado.");
  }

  const { data: order, error: orderError } = await context.admin
    .from("marketplace_orders")
    .insert({
      product_id: product.id,
      buyer_id: context.userId,
      amount_cents: product.price_cents,
      buyer_note: data.buyer_note ?? null,
      status: "pending",
    })
    .select()
    .single();
  if (orderError) throw orderError;
  return { order: { id: order.id, status: order.status } };
}

function isMissingMarketplacePixColumns(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof record?.code === "string" ? record.code : "";
  const text = [record?.message, record?.details]
    .filter((value) => typeof value === "string")
    .join(" ");
  return (
    code === "42703" ||
    code === "PGRST204" ||
    (/schema cache|column|could not find/i.test(text) &&
      /provider_payment_id|client_request_id|qr_code|qr_code_base64|ticket_url|expires_at|buyer_name|buyer_whatsapp|buyer_email|raw/i
        .test(text))
  );
}

async function createMarketplacePixCheckout(context: AuthContext, input: unknown) {
  const data = z
    .object({
      product_id: z.string().uuid(),
      buyer_name: z.string().min(2).max(120),
      buyer_whatsapp: z.string().min(8).max(30),
      buyer_cpf: z.string().max(20).optional(),
      idempotency_key: z.string().uuid(),
    })
    .parse(input);

  const { data: product, error } = await context.admin
    .from("marketplace_products")
    .select("*")
    .eq("id", data.product_id)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!product) {
    throw new ApiHttpError(404, "PRODUCT_NOT_FOUND", "Produto indisponível.");
  }
  if (product.stock !== null && product.stock <= 0) {
    throw new ApiHttpError(409, "OUT_OF_STOCK", "Produto esgotado.");
  }
  if (!product.price_cents || product.price_cents <= 0) {
    throw new ApiHttpError(400, "PAYMENT_NOT_REQUIRED", "Este produto não possui preço válido.");
  }
  if (!context.email) {
    throw new ApiHttpError(
      400,
      "USER_EMAIL_REQUIRED",
      "E-mail do usuário não encontrado. Faça login novamente.",
    );
  }

  const digits = (value: string) => value.replace(/\D+/g, "");
  const buyerName = data.buyer_name.trim().replace(/\s+/g, " ");
  const buyerWhatsapp = digits(data.buyer_whatsapp);
  const buyerCpf = digits(data.buyer_cpf ?? "");
  const legacyRequestNote = `pix:${data.idempotency_key}`;

  let supportsPixColumns = true;
  let existing = await context.admin
    .from("marketplace_orders")
    .select("*")
    .eq("buyer_id", context.userId)
    .eq("client_request_id", data.idempotency_key)
    .maybeSingle();
  if (existing.error) {
    if (!isMissingMarketplacePixColumns(existing.error)) throw existing.error;
    supportsPixColumns = false;
    existing = await context.admin
      .from("marketplace_orders")
      .select("*")
      .eq("buyer_id", context.userId)
      .eq("buyer_note", legacyRequestNote)
      .maybeSingle();
    if (existing.error) throw existing.error;
  }

  let order = existing.data;
  if (!order) {
    const fullInsert = {
      product_id: product.id,
      buyer_id: context.userId,
      amount_cents: product.price_cents,
      status: "pending",
      client_request_id: data.idempotency_key,
      buyer_name: buyerName,
      buyer_whatsapp: buyerWhatsapp,
      buyer_email: context.email,
    };
    const legacyInsert = {
      product_id: product.id,
      buyer_id: context.userId,
      amount_cents: product.price_cents,
      status: "pending",
      buyer_note: legacyRequestNote,
    };
    const insertPayload: Record<string, unknown> = supportsPixColumns ? fullInsert : legacyInsert;
    let inserted = await context.admin
      .from("marketplace_orders")
      .insert(insertPayload as any)
      .select()
      .single();
    if (inserted.error && supportsPixColumns && isMissingMarketplacePixColumns(inserted.error)) {
      supportsPixColumns = false;
      inserted = await context.admin
        .from("marketplace_orders")
        .insert(legacyInsert as any)
        .select()
        .single();
    }
    if (inserted.error) throw inserted.error;
    order = inserted.data;
  }

  const label = `Rise Lovable — ${product.name}`;
  if (order.provider_payment_id && order.qr_code) {
    return {
      order_id: order.id,
      status: order.status,
      qr_code: order.qr_code,
      qr_code_base64: order.qr_code_base64,
      ticket_url: order.ticket_url,
      expires_at: order.expires_at,
      amount_cents: order.amount_cents,
      product_name: label,
    };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  if (!supabaseUrl) throw new Error("SUPABASE_URL não configurada.");

  try {
    const pix = await createPixPayment({
      amountCents: order.amount_cents,
      description: label,
      buyerName,
      buyerEmail: context.email,
      buyerWhatsapp: buyerWhatsapp || undefined,
      buyerCpf: buyerCpf || undefined,
      externalReference: `mkt_${order.id}`,
      notificationUrl: `${supabaseUrl}/functions/v1/mercadopago-webhook`,
      idempotencyKey: order.id,
      expiresInMinutes: 30,
    });

    if (!pix.qr_code && !pix.qr_code_base64) {
      throw new ApiHttpError(
        502,
        "PIX_UNAVAILABLE",
        "O provedor não retornou o QR Code do Pix. Tente novamente em instantes.",
      );
    }

    if (supportsPixColumns) {
      const { error: updateError } = await context.admin
        .from("marketplace_orders")
        .update({
          provider_payment_id: String(pix.raw?.id ?? ""),
          qr_code: pix.qr_code,
          qr_code_base64: pix.qr_code_base64,
          ticket_url: pix.ticket_url,
          expires_at: pix.date_of_expiration,
          raw: pix.raw ?? null,
        })
        .eq("id", order.id);
      if (updateError) {
        if (!isMissingMarketplacePixColumns(updateError)) throw updateError;
        supportsPixColumns = false;
      }
    }

    let status = order.status;
    if (pix.raw?.status === "approved") {
      const delivered = await deliverMarketplaceOrder(context.admin, order.id);
      status = delivered?.status ?? status;
    }

    return {
      order_id: order.id,
      status,
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      ticket_url: pix.ticket_url,
      expires_at: pix.date_of_expiration,
      amount_cents: order.amount_cents,
      product_name: label,
    };
  } catch (error) {
    console.error("[marketplace-pix]", order.id, error instanceof Error ? error.message : error);
    await context.admin
      .from("marketplace_orders")
      .update({ raw: { error: error instanceof Error ? error.message : String(error) } })
      .eq("id", order.id)
      .eq("status", "pending")
      .is("provider_payment_id", null);
    throw error;
  }
}


async function getMarketplaceOrderStatus(context: AuthContext, input: unknown) {
  const data = z.object({ order_id: z.string().uuid() }).parse(input);
  const { data: order, error } = await context.admin
    .from("marketplace_orders")
    .select("*, marketplace_products(name, delivery_instructions)")
    .eq("id", data.order_id)
    .maybeSingle();
  if (error) throw error;
  if (!order) {
    throw new ApiHttpError(404, "ORDER_NOT_FOUND", "Pedido não encontrado.");
  }
  if (order.buyer_id !== context.userId) {
    throw new ApiHttpError(403, "FORBIDDEN", "Acesso negado.");
  }

  let current: any = order;
  if (order.status === "pending" && order.provider_payment_id) {
    try {
      const remote = await getPayment(order.provider_payment_id);
      if (remote?.status === "approved") {
        current = (await deliverMarketplaceOrder(context.admin, order.id)) ?? order;
      } else if (
        ["cancelled", "rejected", "refunded", "charged_back"].includes(String(remote?.status))
      ) {
        const { data: cancelled } = await context.admin
          .from("marketplace_orders")
          .update({ status: "cancelled" })
          .eq("id", order.id)
          .eq("status", "pending")
          .select()
          .maybeSingle();
        current = cancelled ?? order;
      }
    } catch (pollError) {
      console.warn("[marketplace-poll]", String(pollError));
    }
  }

  return {
    status: current.status,
    delivered_content: current.status === "delivered" ? current.delivered_content : null,
    delivery_instructions: order.marketplace_products?.delivery_instructions ?? null,
    product_name: order.marketplace_products?.name ?? null,
  };
}

async function listMyMarketplaceOrders(context: AuthContext) {
  const { data, error } = await context.admin
    .from("marketplace_orders")
    .select("*, marketplace_products(name, delivery_type, delivery_instructions)")
    .eq("buyer_id", context.userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return {
    orders: (data ?? []).map((row: any) => ({
      id: row.id,
      status: row.status,
      amount_cents: row.amount_cents,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
      product_name: row.marketplace_products?.name ?? null,
      delivery_type: row.marketplace_products?.delivery_type ?? null,
      delivery_instructions: row.marketplace_products?.delivery_instructions ?? null,
      delivered_content: row.status === "delivered" ? row.delivered_content : null,
    })),
  };
}

/** Substitui o estoque unitário do produto (um entregável por unidade). */
async function replaceStockItems(admin: any, productId: string, items: string[]) {
  const { data: existing, error } = await admin
    .from("marketplace_stock_items")
    .select("id, content, order_id")
    .eq("product_id", productId);
  if (error) throw error;

  const rows = existing ?? [];
  const used = rows.filter((row: any) => row.order_id);
  const available = rows.filter((row: any) => !row.order_id);
  const wanted = items.map((item) => item.trim()).filter(Boolean);

  // Mantém as unidades já entregues; só o estoque disponível é reescrito.
  const usedContents = new Set(used.map((row: any) => row.content));
  const target = wanted.filter((item) => !usedContents.has(item));

  const keep: string[] = [];
  const toDelete: string[] = [];
  const remaining = [...target];
  for (const row of available) {
    const index = remaining.indexOf(row.content);
    if (index >= 0) {
      remaining.splice(index, 1);
      keep.push(row.content);
    } else {
      toDelete.push(row.id);
    }
  }

  if (toDelete.length) {
    const { error: deleteError } = await admin
      .from("marketplace_stock_items")
      .delete()
      .in("id", toDelete);
    if (deleteError) throw deleteError;
  }
  if (remaining.length) {
    const { error: insertError } = await admin
      .from("marketplace_stock_items")
      .insert(remaining.map((content) => ({ product_id: productId, content })));
    if (insertError) throw insertError;
  }
  return keep.length + remaining.length;
}

async function loadStockItems(admin: any, productIds: string[]) {
  if (!productIds.length) return new Map<string, any[]>();
  const { data, error } = await admin
    .from("marketplace_stock_items")
    .select("id, product_id, content, order_id, delivered_at, created_at")
    .in("product_id", productIds)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const map = new Map<string, any[]>();
  for (const row of data ?? []) {
    const list = map.get(row.product_id) ?? [];
    list.push(row);
    map.set(row.product_id, list);
  }
  return map;
}

async function adminListMarketplaceProducts(context: AuthContext) {
  await assertAdmin(context);
  const { data, error } = await context.admin
    .from("marketplace_products")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = data ?? [];
  const items = await loadStockItems(
    context.admin,
    rows.map((row: any) => row.id),
  );
  return {
    products: rows.map((row: any) => {
      const list = items.get(row.id) ?? [];
      return {
        ...row,
        stock_items: list.filter((item: any) => !item.order_id).map((item: any) => item.content),
        stock_items_used: list.filter((item: any) => !!item.order_id).length,
      };
    }),
  };
}

async function adminCreateMarketplaceProduct(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const { stock_items, ...parsed } = productSchema.parse(input);
  const data = {
    ...parsed,
    cover_url: await persistMarketplaceImage(context, parsed.cover_url),
  };
  const { data: product, error } = await context.admin
    .from("marketplace_products")
    .insert(stock_items && stock_items.length ? { ...data, stock: stock_items.length } : data)
    .select()
    .single();
  if (error) throw error;
  if (stock_items) await replaceStockItems(context.admin, product.id, stock_items);
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "create_marketplace_product",
    target_type: "marketplace_product",
    target_id: product.id,
  });
  return { product };
}

async function adminUploadMarketplaceImage(context: AuthContext, input: unknown) {
  await assertAdmin(context);
  const { data_url } = z
    .object({
      data_url: z.string().max(650_000, "A imagem excede o limite permitido."),
    })
    .parse(input);
  return { url: await persistMarketplaceImage(context, data_url) };
}

async function persistMarketplaceImage(
  context: AuthContext,
  value: string | null | undefined,
): Promise<string | null> {
  if (!value) return null;
  if (!value.startsWith("data:image/")) return value;

  const match = /^data:image\/(webp);base64,([a-z0-9+/=]+)$/i.exec(value);
  if (!match) {
    throw new ApiHttpError(400, "INVALID_IMAGE", "A imagem enviada é inválida.");
  }

  const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
  if (bytes.byteLength > 500_000) {
    throw new ApiHttpError(400, "IMAGE_TOO_LARGE", "A imagem excede o limite permitido.");
  }

  const path = `products/${crypto.randomUUID()}.webp`;
  const { error: uploadError } = await context.admin.storage
    .from("marketplace")
    .upload(path, bytes, {
      cacheControl: "31536000",
      contentType: "image/webp",
      upsert: false,
    });
  if (uploadError) {
    console.error("[marketplace-image-upload]", uploadError.message);
    throw new ApiHttpError(
      500,
      "IMAGE_UPLOAD_FAILED",
      "Não foi possível armazenar a imagem. Tente novamente.",
      { cause: uploadError },
    );
  }

  const { data: signed, error: signError } = await context.admin.storage
    .from("marketplace")
    .createSignedUrl(path, 60 * 60 * 24 * 365 * 10);
  if (signError || !signed?.signedUrl) {
    throw new ApiHttpError(
      500,
      "IMAGE_URL_FAILED",
      "A imagem foi enviada, mas não foi possível gerar o link.",
      { cause: signError },
    );
  }
  return signed.signedUrl;
}

async function adminUpdateMarketplaceProduct(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = productSchema.extend({ id: z.string().uuid() }).parse(input);
  const { id, stock_items, ...updates } = data;
  updates.cover_url = await persistMarketplaceImage(context, updates.cover_url);
  if (stock_items) {
    await replaceStockItems(context.admin, id, stock_items);
    (updates as any).stock = stock_items.length;
  }
  const { data: product, error } = await context.admin
    .from("marketplace_products")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "update_marketplace_product",
    target_type: "marketplace_product",
    target_id: id,
  });
  return { product };
}

async function adminDeleteMarketplaceProduct(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = z.object({ product_id: z.string().uuid() }).parse(input);
  const { error } = await context.admin
    .from("marketplace_products")
    .delete()
    .eq("id", data.product_id);
  if (error) throw error;
  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "delete_marketplace_product",
    target_type: "marketplace_product",
    target_id: data.product_id,
  });
  return { ok: true };
}

async function adminListMarketplaceOrders(context: AuthContext) {
  await assertAdmin(context);
  const [ordersResult, usersResult] = await Promise.all([
    context.admin
      .from("marketplace_orders")
      .select("*, marketplace_products(name, delivery_type, delivery_content)")
      .order("created_at", { ascending: false })
      .limit(500),
    context.admin.auth.admin.listUsers({ page: 1, perPage: 500 }),
  ]);
  if (ordersResult.error) throw ordersResult.error;
  const emails = new Map((usersResult.data?.users ?? []).map((user: any) => [user.id, user.email]));
  return {
    orders: (ordersResult.data ?? []).map((row: any) => ({
      id: row.id,
      status: row.status,
      amount_cents: row.amount_cents,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
      buyer_id: row.buyer_id,
      buyer_email: emails.get(row.buyer_id) ?? null,
      buyer_note: row.buyer_note,
      delivered_content: row.delivered_content,
      product_name: row.marketplace_products?.name ?? null,
      delivery_type: row.marketplace_products?.delivery_type ?? null,
    })),
  };
}

async function adminUpdateMarketplaceOrder(context: AuthContext, input: unknown) {
  const adminId = await assertAdmin(context);
  const data = z
    .object({
      order_id: z.string().uuid(),
      status: z.enum(["pending", "paid", "delivered", "cancelled"]),
      delivered_content: z.string().max(20_000).optional().nullable(),
    })
    .parse(input);

  const { data: order, error } = await context.admin
    .from("marketplace_orders")
    .select("*, marketplace_products(delivery_type, delivery_content, stock, id)")
    .eq("id", data.order_id)
    .maybeSingle();
  if (error) throw error;
  if (!order) {
    throw new ApiHttpError(404, "ORDER_NOT_FOUND", "Pedido não encontrado.");
  }

  const product: any = order.marketplace_products ?? {};
  let status = data.status;
  let delivered_content = data.delivered_content ?? order.delivered_content ?? null;
  let delivered_at = order.delivered_at;
  let unitContent: string | null = null;

  // Pagamento confirmado: entrega automática (uma unidade do estoque por pedido).
  if (status === "paid" && product.delivery_type !== "manual") {
    if (!delivered_content && product.id) {
      const claimed = await context.admin.rpc("claim_marketplace_stock_item", {
        p_product_id: product.id,
        p_order_id: order.id,
      });
      if (claimed.error) throw claimed.error;
      unitContent = (claimed.data as string | null) ?? null;
    }
    delivered_content = delivered_content ?? unitContent ?? product.delivery_content ?? null;
    if (delivered_content) status = "delivered";
  }
  if (status === "delivered") {
    if (!delivered_content) {
      throw new ApiHttpError(
        400,
        "DELIVERY_CONTENT_REQUIRED",
        "Informe o entregável antes de marcar como entregue.",
      );
    }
    delivered_at = delivered_at ?? new Date().toISOString();
    if (
      !unitContent &&
      order.status !== "delivered" &&
      product.id &&
      typeof product.stock === "number"
    ) {
      await context.admin
        .from("marketplace_products")
        .update({ stock: Math.max(0, product.stock - 1) })
        .eq("id", product.id);
    }
  }

  const { data: updated, error: updateError } = await context.admin
    .from("marketplace_orders")
    .update({ status, delivered_content, delivered_at })
    .eq("id", data.order_id)
    .select()
    .single();
  if (updateError) throw updateError;

  await context.admin.from("admin_audit_log").insert({
    admin_id: adminId,
    action: "update_marketplace_order",
    target_type: "marketplace_order",
    target_id: data.order_id,
    details: { status },
  });
  return { order: { id: updated.id, status: updated.status } };
}

async function dispatch(action: string, input: unknown, context: AuthContext): Promise<unknown> {
  switch (action) {
    case "getMyAccessContext":
      return getMyAccessContext(context);
    case "claimResellerAccess":
      return claimResellerAccess(context);
    case "getMyDashboard":
      return getMyDashboard(context);
    case "claimTrialLicense":
      return claimTrialLicense(context);
    case "getAdminOverview":
      return getAdminOverview(context);
    case "adminUpdateLicenseStatus":
      return adminUpdateLicenseStatus(context, input);
    case "adminGenerateLicenses":
      return adminGenerateLicenses(context, input);
    case "adminDeleteLicense":
      return adminDeleteLicense(context, input);
    case "adminCreatePlan":
      return adminCreatePlan(context, input);
    case "adminUpdatePlan":
      return adminUpdatePlan(context, input);
    case "adminListUsers":
      return adminListUsers(context);
    case "adminSetUserRole":
      return adminSetUserRole(context, input);
    case "adminDeleteUser":
      return adminDeleteUser(context, input);
    case "adminGetAuditLog":
      return adminGetAuditLog(context);
    case "adminListPayments":
      return adminListPayments(context);
    case "getMyResellerInfo":
      return getMyResellerInfo(context);
    case "getResellerStats":
      return getResellerStats(context, input);
    case "adminListResellers":
      return adminListResellers(context, input);
    case "adminGetResellerDetail":
      return adminGetResellerDetail(context, input);
    case "adminGetGlobalRevenue":
      return adminGetGlobalRevenue(context, input);
    case "createPixCheckout":
      return createPixCheckout(context, input);
    case "getCheckoutStatus":
      return getCheckoutStatus(context, input);
    case "getAdminAccessStatus":
      return getAdminAccessStatus(context);
    case "listMarketplaceProducts":
      return listMarketplaceProducts(context);
    case "createMarketplaceOrder":
      return createMarketplaceOrder(context, input);
    case "createMarketplacePixCheckout":
      return createMarketplacePixCheckout(context, input);
    case "getMarketplaceOrderStatus":
      return getMarketplaceOrderStatus(context, input);
    case "listMyMarketplaceOrders":
      return listMyMarketplaceOrders(context);
    case "adminListMarketplaceProducts":
      return adminListMarketplaceProducts(context);
    case "adminCreateMarketplaceProduct":
      return adminCreateMarketplaceProduct(context, input);
    case "adminUploadMarketplaceImage":
      return adminUploadMarketplaceImage(context, input);
    case "adminUpdateMarketplaceProduct":
      return adminUpdateMarketplaceProduct(context, input);
    case "adminDeleteMarketplaceProduct":
      return adminDeleteMarketplaceProduct(context, input);
    case "adminListMarketplaceOrders":
      return adminListMarketplaceOrders(context);
    case "adminUpdateMarketplaceOrder":
      return adminUpdateMarketplaceOrder(context, input);
    default:
      throw new ApiHttpError(404, "UNKNOWN_ACTION", "Ação desconhecida.");
  }
}

Deno.serve(async (request) => {
  const http = createHttpContext(request, "protected");
  try {
    assertAllowedOrigin(http);
    if (request.method === "OPTIONS") return options(http);
    if (request.method !== "POST") {
      throw new ApiHttpError(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
    }
    const body = await readJson(request);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const action = record?.action;
    if (typeof action !== "string" || action.length > 80) {
      throw new ApiHttpError(400, "ACTION_REQUIRED", "Ação obrigatória.");
    }
    if (!BACKEND_ACTIONS.has(action)) {
      throw new ApiHttpError(404, "UNKNOWN_ACTION", "Ação desconhecida.");
    }
    const context = await requireUser(request);
    await enforceBackendRateLimit(context, action, http.requestId);
    return json(await dispatch(action, record?.data, context), 200, http);
  } catch (error) {
    return errorResponse(error, http);
  }
});
