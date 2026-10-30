import { FakePaymentProvider } from "./fake";
import type { PaymentProvider } from "./types";

export type { PaymentProvider } from "./types";

export function getPaymentProvider(): PaymentProvider {
  const provider = process.env.PAYMENT_PROVIDER;
  switch (provider) {
    case "fake":
      return new FakePaymentProvider({
        statePath: process.env.FAKE_PAYMENTS_STATE_PATH ?? ".local/fake-payments.json",
        webhookSecret: requireEnv("PAYMENT_WEBHOOK_SECRET"),
        webhookUrl: process.env.PAYMENT_WEBHOOK_URL,
        duplicateWebhooks: Number(process.env.FAKE_PAYMENT_WEBHOOK_DUPLICATES ?? 0),
      });
    default:
      throw new Error(`Unsupported PAYMENT_PROVIDER: ${provider}`);
  }
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
