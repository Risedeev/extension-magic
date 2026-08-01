import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  assertMercadoPagoPaymentContract,
  mercadoPagoIdentification,
  verifyMercadoPagoWebhookSignature,
} from "./mercadopago.ts";
import { ApiHttpError } from "./http.ts";

Deno.test("normaliza CPF e CNPJ do pagador Mercado Pago", () => {
  assertEquals(mercadoPagoIdentification("123.456.789-01"), {
    type: "CPF",
    number: "12345678901",
  });
  assertEquals(mercadoPagoIdentification("12.345.678/0001-90"), {
    type: "CNPJ",
    number: "12345678000190",
  });
  assertEquals(mercadoPagoIdentification("123"), null);
});

async function hmacHex(secret: string, value: string): Promise<string> {
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
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("assinatura Mercado Pago aceita HMAC válido e rejeita adulteração", async () => {
  const secret = "test_webhook_secret";
  const dataId = "999999999";
  const requestId = "request-mercadopago-123";
  const timestamp = "1704908010";
  Deno.env.set("MERCADO_PAGO_WEBHOOK_SECRET", secret);
  const hash = await hmacHex(
    secret,
    `id:${dataId};request-id:${requestId};ts:${timestamp};`,
  );
  const validRequest = new Request(`https://edge.test?data.id=${dataId}`, {
    headers: {
      "x-request-id": requestId,
      "x-signature": `ts=${timestamp},v1=${hash}`,
    },
  });
  assertEquals(await verifyMercadoPagoWebhookSignature(validRequest, dataId), {
    configured: true,
    valid: true,
  });

  const invalidRequest = new Request(`https://edge.test?data.id=${dataId}`, {
    headers: {
      "x-request-id": requestId,
      "x-signature": `ts=${timestamp},v1=${"0".repeat(64)}`,
    },
  });
  assertEquals(
    await verifyMercadoPagoWebhookSignature(invalidRequest, dataId),
    {
      configured: true,
      valid: false,
    },
  );
});

Deno.test("reconciliação Mercado Pago exige id, valor, moeda e referência", () => {
  const remote = {
    id: 123456,
    status: "approved",
    external_reference: "d48d4ef2-759d-4ae7-bcc7-d93a00b57f88",
    transaction_amount: 59.9,
    currency_id: "BRL",
    payment_method_id: "pix",
    payer: { email: "cliente@example.com" },
  };
  assertEquals(
    assertMercadoPagoPaymentContract(remote, {
      paymentId: remote.external_reference,
      providerPaymentId: "123456",
      amountCents: 5990,
      buyerEmail: "CLIENTE@example.com",
    }),
    { providerId: "123456", status: "approved" },
  );

  assertThrows(
    () =>
      assertMercadoPagoPaymentContract(remote, {
        paymentId: remote.external_reference,
        providerPaymentId: "123456",
        amountCents: 5991,
        buyerEmail: "cliente@example.com",
      }),
    ApiHttpError,
  );
});

Deno.test("reconciliação Pix não bloqueia quando o e-mail do provedor diverge", () => {
  const remote = {
    id: 123456,
    status: "approved",
    external_reference: "d48d4ef2-759d-4ae7-bcc7-d93a00b57f88",
    transaction_amount: 59.9,
    currency_id: "BRL",
    payment_method_id: "pix",
    payer: { email: "outro-email@example.com" },
  };
  assertEquals(
    assertMercadoPagoPaymentContract(remote, {
      paymentId: remote.external_reference,
      providerPaymentId: "123456",
      amountCents: 5990,
      buyerEmail: "cliente@example.com",
    }),
    { providerId: "123456", status: "approved" },
  );
});
