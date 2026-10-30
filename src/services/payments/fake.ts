import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CreatePaymentInput,
  DepositHold,
  HoldDepositInput,
  Payment,
  PaymentEventType,
  PaymentProvider,
  PaymentWebhookEvent,
} from "./types";

/** Pass one of these as paymentMethod to choose the outcome. */
export const FAKE_PAYMENT_METHODS = {
  success: "fake_success",
  fail: "fake_fail",
  /** Stays pending so that it can be canceled. */
  pending: "fake_pending",
} as const;

export const WEBHOOK_SIGNATURE_HEADER = "x-payment-signature";

export interface FakePaymentOptions {
  statePath: string;
  webhookSecret: string;
  webhookUrl?: string;
  /** Extra copies of every webhook to send, for testing duplicate handling. */
  duplicateWebhooks?: number;
}

interface State {
  payments: Record<string, Payment>;
  holds: Record<string, DepositHold>;
  events: Record<string, PaymentWebhookEvent>;
  idempotencyKeys: Record<string, string>;
}

export class FakePaymentProvider implements PaymentProvider {
  constructor(private readonly options: FakePaymentOptions) {}

  async createPayment(input: CreatePaymentInput): Promise<Payment> {
    const state = this.load();
    const existingId = input.idempotencyKey && state.idempotencyKeys[input.idempotencyKey];
    if (existingId) return state.payments[existingId];

    const status =
      input.paymentMethod === FAKE_PAYMENT_METHODS.success
        ? "succeeded"
        : input.paymentMethod === FAKE_PAYMENT_METHODS.fail
          ? "failed"
          : input.paymentMethod === FAKE_PAYMENT_METHODS.pending
            ? "pending"
            : null;
    if (!status) throw new Error(`Unknown fake payment method: ${input.paymentMethod}`);

    const payment: Payment = {
      id: `fake_pay_${randomUUID()}`,
      status,
      amountCents: input.amountCents,
      refundedCents: 0,
      currency: input.currency,
      metadata: input.metadata ?? {},
    };
    state.payments[payment.id] = payment;
    if (input.idempotencyKey) state.idempotencyKeys[input.idempotencyKey] = payment.id;

    if (status === "succeeded") await this.commit(state, "payment.succeeded", payment);
    else if (status === "failed") await this.commit(state, "payment.failed", payment);
    else this.save(state);
    return payment;
  }

  async cancelPayment(paymentId: string): Promise<Payment> {
    const state = this.load();
    const payment = getOrThrow(state.payments, paymentId);
    if (payment.status === "canceled") return payment;
    if (payment.status !== "pending") {
      throw new Error(`Cannot cancel a ${payment.status} payment`);
    }
    payment.status = "canceled";
    await this.commit(state, "payment.canceled", payment);
    return payment;
  }

  async refundPayment(paymentId: string, amountCents?: number): Promise<Payment> {
    const state = this.load();
    const payment = getOrThrow(state.payments, paymentId);
    if (payment.status !== "succeeded" && payment.status !== "partially_refunded") {
      throw new Error(`Cannot refund a ${payment.status} payment`);
    }
    const remaining = payment.amountCents - payment.refundedCents;
    const amount = amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) {
      throw new Error(`Refund of ${amount} is outside the remaining ${remaining}`);
    }
    payment.refundedCents += amount;
    payment.status = payment.refundedCents === payment.amountCents ? "refunded" : "partially_refunded";
    await this.commit(state, "payment.refunded", payment);
    return payment;
  }

  async holdDeposit(input: HoldDepositInput): Promise<DepositHold> {
    const state = this.load();
    if (
      input.paymentMethod !== FAKE_PAYMENT_METHODS.success &&
      input.paymentMethod !== FAKE_PAYMENT_METHODS.fail
    ) {
      throw new Error(`Unknown fake payment method: ${input.paymentMethod}`);
    }
    const failed = input.paymentMethod === FAKE_PAYMENT_METHODS.fail;
    const hold: DepositHold = {
      id: `fake_hold_${randomUUID()}`,
      status: failed ? "failed" : "held",
      amountCents: input.amountCents,
      currency: input.currency,
      expiresAt: input.expiresAt.toISOString(),
      metadata: input.metadata ?? {},
    };
    state.holds[hold.id] = hold;
    await this.commit(state, failed ? "deposit.failed" : "deposit.held", hold);
    return hold;
  }

  async releaseDeposit(holdId: string): Promise<DepositHold> {
    const state = this.load();
    const hold = getOrThrow(state.holds, holdId);
    if (hold.status === "released") return hold;
    if (hold.status !== "held") throw new Error(`Cannot release a ${hold.status} hold`);
    hold.status = "released";
    await this.commit(state, "deposit.released", hold);
    return hold;
  }

  async listExpiredHolds(now: Date): Promise<DepositHold[]> {
    return Object.values(this.load().holds).filter(
      (hold) => hold.status === "held" && new Date(hold.expiresAt) <= now,
    );
  }

  verifyWebhook(rawBody: string, signature: string): PaymentWebhookEvent {
    const expected = Buffer.from(this.sign(rawBody));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("Invalid webhook signature");
    }
    return JSON.parse(rawBody) as PaymentWebhookEvent;
  }

  /** Test helper: delivers an already-sent event again. */
  async replayWebhook(eventId: string): Promise<void> {
    await this.deliver(getOrThrow(this.load().events, eventId));
  }

  /** Test helper: lists every event sent so far. */
  listEvents(): PaymentWebhookEvent[] {
    return Object.values(this.load().events);
  }

  private async commit(state: State, type: PaymentEventType, data: Payment | DepositHold) {
    const event: PaymentWebhookEvent = {
      id: `fake_evt_${randomUUID()}`,
      type,
      createdAt: new Date().toISOString(),
      data,
    };
    state.events[event.id] = event;
    this.save(state);
    for (let copy = 0; copy <= (this.options.duplicateWebhooks ?? 0); copy++) {
      await this.deliver(event);
    }
  }

  // A receiver that is down must not change the payment result, as with a real provider.
  private async deliver(event: PaymentWebhookEvent) {
    if (!this.options.webhookUrl) return;
    const body = JSON.stringify(event);
    try {
      const response = await fetch(this.options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", [WEBHOOK_SIGNATURE_HEADER]: this.sign(body) },
        body,
      });
      if (!response.ok) console.warn(`Webhook ${event.id} got HTTP ${response.status}`);
    } catch (error) {
      console.warn(`Webhook ${event.id} was not delivered: ${(error as Error).message}`);
    }
  }

  private sign(body: string) {
    return createHmac("sha256", this.options.webhookSecret).update(body).digest("hex");
  }

  private load(): State {
    if (!existsSync(this.options.statePath)) {
      return { payments: {}, holds: {}, events: {}, idempotencyKeys: {} };
    }
    return JSON.parse(readFileSync(this.options.statePath, "utf8")) as State;
  }

  private save(state: State) {
    mkdirSync(dirname(this.options.statePath), { recursive: true });
    const temp = `${this.options.statePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2));
    renameSync(temp, this.options.statePath);
  }
}

function getOrThrow<T>(records: Record<string, T>, id: string): T {
  const record = records[id];
  if (!record) throw new Error(`Not found: ${id}`);
  return record;
}
