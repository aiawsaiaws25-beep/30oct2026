import { getPaymentProvider, type PaymentProvider } from "../payments";

export interface CleanupProvider {
  releaseExpiredHolds(now: Date): Promise<{ released: string[] }>;
}

export class LocalCleanupProvider implements CleanupProvider {
  constructor(private readonly payments: PaymentProvider) {}

  async releaseExpiredHolds(now: Date) {
    const released: string[] = [];
    for (const hold of await this.payments.listExpiredHolds(now)) {
      await this.payments.releaseDeposit(hold.id);
      released.push(hold.id);
    }
    return { released };
  }
}

export function getCleanupProvider(): CleanupProvider {
  const provider = process.env.CLEANUP_PROVIDER;
  switch (provider) {
    case "local":
      return new LocalCleanupProvider(getPaymentProvider());
    default:
      throw new Error(`Unsupported CLEANUP_PROVIDER: ${provider}`);
  }
}
