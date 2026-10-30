import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalCleanupProvider } from "./cleanup";
import { FAKE_PAYMENT_METHODS, FakePaymentProvider, WEBHOOK_SIGNATURE_HEADER } from "./payments/fake";
import { LocalStorageProvider } from "./storage/local";

const { success, fail, pending } = FAKE_PAYMENT_METHODS;
const money = { amountCents: 5000, currency: "usd" };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "driveeasy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function provider(extra: { webhookUrl?: string; duplicateWebhooks?: number } = {}) {
  return new FakePaymentProvider({ statePath: join(dir, "state.json"), webhookSecret: "s", ...extra });
}

describe("fake payments", () => {
  it("succeeds, fails and cancels", async () => {
    const payments = provider();
    expect((await payments.createPayment({ ...money, paymentMethod: success })).status).toBe("succeeded");
    expect((await payments.createPayment({ ...money, paymentMethod: fail })).status).toBe("failed");
    const open = await payments.createPayment({ ...money, paymentMethod: pending });
    expect((await payments.cancelPayment(open.id)).status).toBe("canceled");
  });

  it("refunds partially, then fully, and rejects over-refunds", async () => {
    const payments = provider();
    const { id } = await payments.createPayment({ ...money, paymentMethod: success });
    expect((await payments.refundPayment(id, 2000)).status).toBe("partially_refunded");
    await expect(payments.refundPayment(id, 3001)).rejects.toThrow();
    expect((await payments.refundPayment(id)).status).toBe("refunded");
  });

  it("returns the original payment for a repeated idempotency key", async () => {
    const payments = provider();
    const input = { ...money, paymentMethod: success, idempotencyKey: "k" };
    expect((await payments.createPayment(input)).id).toBe((await payments.createPayment(input)).id);
  });

  it("holds and releases deposits, and sends one event per release", async () => {
    const payments = provider();
    const hold = await payments.holdDeposit({ ...money, paymentMethod: success, expiresAt: new Date() });
    expect(hold.status).toBe("held");
    await payments.releaseDeposit(hold.id);
    expect((await payments.releaseDeposit(hold.id)).status).toBe("released");
    expect(payments.listEvents().filter((e) => e.type === "deposit.released")).toHaveLength(1);
  });

  it("rejects a bad webhook signature", () => {
    expect(() => provider().verifyWebhook("{}", "wrong")).toThrow("Invalid webhook signature");
  });
});

describe("fake payment webhooks", () => {
  let server: Server;
  let received: { body: string; signature: string }[];
  let webhookUrl: string;

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ body, signature: String(req.headers[WEBHOOK_SIGNATURE_HEADER]) });
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise((done) => server.close(done)));

  it("sends signed duplicates that share one event id", async () => {
    const payments = provider({ webhookUrl, duplicateWebhooks: 1 });
    await payments.createPayment({ ...money, paymentMethod: success });
    expect(received).toHaveLength(2);
    const events = received.map((r) => payments.verifyWebhook(r.body, r.signature));
    expect(events[0].id).toBe(events[1].id);
    expect(events[0].type).toBe("payment.succeeded");
  });

  it("replays an event on request", async () => {
    const payments = provider({ webhookUrl });
    await payments.createPayment({ ...money, paymentMethod: success });
    await payments.replayWebhook(payments.listEvents()[0].id);
    expect(received).toHaveLength(2);
  });

  it("keeps the payment when the receiver is down", async () => {
    const payments = provider({ webhookUrl: "http://127.0.0.1:1" });
    expect((await payments.createPayment({ ...money, paymentMethod: success })).status).toBe("succeeded");
  });
});

describe("cleanup", () => {
  it("releases only expired holds", async () => {
    const payments = provider();
    const now = new Date("2026-01-02T00:00:00Z");
    const expired = await payments.holdDeposit({
      ...money,
      paymentMethod: success,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    await payments.holdDeposit({ ...money, paymentMethod: success, expiresAt: new Date("2026-01-03T00:00:00Z") });
    const cleanup = new LocalCleanupProvider(payments);
    expect(await cleanup.releaseExpiredHolds(now)).toEqual({ released: [expired.id] });
    expect(await cleanup.releaseExpiredHolds(now)).toEqual({ released: [] });
  });
});

describe("local storage", () => {
  it("saves, reads and deletes", async () => {
    const storage = new LocalStorageProvider("uploads", dir);
    await storage.save("a/b.txt", Buffer.from("hi"));
    expect((await storage.read("a/b.txt")).toString()).toBe("hi");
    await storage.delete("a/b.txt");
    expect(await storage.exists("a/b.txt")).toBe(false);
  });

  it("rejects keys that leave the uploads folder", async () => {
    const storage = new LocalStorageProvider("uploads", dir);
    await expect(storage.save("../evil.txt", Buffer.from("x"))).rejects.toThrow("Invalid storage key");
  });

  it("refuses a folder inside public", () => {
    expect(() => new LocalStorageProvider("public/uploads", dir)).toThrow("public");
  });
});
