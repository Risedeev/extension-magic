import { assertEquals } from "jsr:@std/assert@1.0.19";
import { effectiveProviderStatus } from "./payments.ts";

Deno.test("status aprovado do provedor prevalece sobre estados fracos anteriores", () => {
  assertEquals(
    effectiveProviderStatus({ status: "pending", paid_at: null }, "approved"),
    "approved",
  );
  assertEquals(
    effectiveProviderStatus({ status: "cancelled", paid_at: null }, "approved"),
    "approved",
  );
  assertEquals(
    effectiveProviderStatus({ status: "rejected", paid_at: null }, "approved"),
    "approved",
  );
});

Deno.test("pagamento pago não volta para pendente por evento atrasado", () => {
  assertEquals(
    effectiveProviderStatus({ status: "approved", paid_at: null }, "pending"),
    "approved",
  );
  assertEquals(
    effectiveProviderStatus({ status: "pending", paid_at: "2026-08-01T12:00:00.000Z" }, "cancelled"),
    "approved",
  );
});

Deno.test("estorno e chargeback continuam definitivos", () => {
  assertEquals(
    effectiveProviderStatus({ status: "approved", paid_at: "2026-08-01T12:00:00.000Z" }, "refunded"),
    "refunded",
  );
  assertEquals(
    effectiveProviderStatus({ status: "charged_back", paid_at: "2026-08-01T12:00:00.000Z" }, "approved"),
    "charged_back",
  );
});
