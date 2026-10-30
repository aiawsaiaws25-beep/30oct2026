export type PaymentStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "canceled"
  | "partially_refunded"
  | "refunded";

export type HoldStatus = "held" | "failed" | "released";

export interface Payment {
  id: string;
  status: PaymentStatus;
  amountCents: number;
  refundedCents: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface DepositHold {
  id: string;
  status: HoldStatus;
  amountCents: number;
  currency: string;
  expiresAt: string;
  metadata: Record<string, string>;
}

export interface CreatePaymentInput {
  amountCents: number;
  currency: string;
  paymentMethod: string;
  /** Repeating a call with the same key returns the original payment. */
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface HoldDepositInput {
  amountCents: number;
  currency: string;
  paymentMethod: string;
  expiresAt: Date;
  metadata?: Record<string, string>;
}

export type PaymentEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.canceled"
  | "payment.refunded"
  | "deposit.held"
  | "deposit.failed"
  | "deposit.released";

/** Duplicate deliveries of one event share an id, so receivers must dedupe on it. */
export interface PaymentWebhookEvent {
  id: string;
  type: PaymentEventType;
  createdAt: string;
  data: Payment | DepositHold;
}

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<Payment>;
  cancelPayment(paymentId: string): Promise<Payment>;
  /** Refunds the remaining balance when amountCents is omitted. */
  refundPayment(paymentId: string, amountCents?: number): Promise<Payment>;
  holdDeposit(input: HoldDepositInput): Promise<DepositHold>;
  releaseDeposit(holdId: string): Promise<DepositHold>;
  listExpiredHolds(now: Date): Promise<DepositHold[]>;
  /** Throws if the signature does not match the raw request body. */
  verifyWebhook(rawBody: string, signature: string): PaymentWebhookEvent;
}
