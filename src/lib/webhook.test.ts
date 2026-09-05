import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryOrderStore, DEFAULT_LEASE_MS } from "./orders.ts";
import { createWebhookHandler } from "./webhook.ts";
import type { OrderResult } from "./providers/types.ts";

// Synthetic fixture, never a catalogue entry or provider quote.
const item = {
  sku: "test-plan", destinationSlug: "test-destination", gb: 5, days: 30,
  retailCents: 1200, wholesaleCents: 500, providerPlanId: "fixture-plan", active: true,
};

const SESSION_ID = "cs_test_123";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    payment_status: "paid",
    amount_total: 1200,
    currency: "usd",
    metadata: { sku: item.sku, providerPlanId: item.providerPlanId },
    customer_details: { email: "buyer@example.com" },
    ...overrides,
  };
}

// Only the fields the handler reads. `constructEvent` is stubbed, so this never
// has to survive Stripe's own signature check or type guards.
function event(type: string, object: unknown = session()) {
  return { id: "evt_test_1", type, data: { object } } as never;
}

const provisioned: OrderResult = {
  providerOrderId: "order-1",
  activationCode: "LPA:1$rsp.example.com$FIXTURE",
  qrPayload: "LPA:1$rsp.example.com$FIXTURE",
};

function setup(overrides: Partial<Parameters<typeof createWebhookHandler>[0]> = {}) {
  let t = Date.parse("2026-09-05T00:00:00Z");
  const orders = createMemoryOrderStore({ now: () => t });
  const calls: unknown[] = [];
  const succeed = async () => provisioned;
  let nextOrder: () => Promise<OrderResult> = succeed;
  /** Settled by the test to let a blocked createOrder finish. */
  let release: ((outcome: "resolve" | "reject") => void) | null = null;

  const handler = createWebhookHandler({
    configured: true,
    constructEvent: () => { throw new Error("no event stubbed — pass constructEvent in overrides"); },
    findSku: (sku) => (sku === item.sku ? item : undefined),
    getProvider: () => ({
      name: "fixture",
      listPlans: async () => [],
      createOrder: async (req) => { calls.push(req); return nextOrder(); },
      getUsage: async () => { throw new Error("not used in these tests"); },
    }),
    orders,
    ...overrides,
  });

  return {
    handler, calls, orders,
    order: () => orders.get(SESSION_ID),
    advance: (ms: number) => { t += ms; },
    /** Make exactly the next createOrder call throw, then return to succeeding. */
    failNextOrder: () => {
      nextOrder = async () => { nextOrder = succeed; throw new Error("provider outage"); };
    },
    /** Make the next createOrder hang until `releaseOrder(...)` is called. */
    blockNextOrder: () => {
      nextOrder = () => new Promise((resolve, reject) => {
        release = (outcome) => outcome === "resolve" ? resolve(provisioned) : reject(new Error("provider outage"));
        nextOrder = succeed;
      });
    },
    releaseOrder: (outcome: "resolve" | "reject" = "resolve") => release?.(outcome),
    send: () => handler(new Request("https://store.example/api/webhook", {
      method: "POST", body: "raw-body", headers: { "stripe-signature": "sig" },
    })),
  };
}

test("an unconfigured webhook returns 503 before reading the event", async () => {
  const { send, calls } = setup({
    configured: false,
    constructEvent: () => { throw new Error("must not be called"); },
  });
  assert.equal((await send()).status, 503);
  assert.equal(calls.length, 0);
});

test("a missing stripe-signature header returns 400", async () => {
  const { handler, calls } = setup();
  const response = await handler(new Request("https://store.example/api/webhook", {
    method: "POST", body: "raw-body",
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("a signature Stripe rejects returns 400 without provisioning", async () => {
  const { send, calls } = setup({
    constructEvent: () => { throw new Error("signature mismatch"); },
  });
  assert.equal((await send()).status, 400);
  assert.equal(calls.length, 0);
});

test("unrelated event types are acknowledged without action", async () => {
  const { send, calls, order } = setup({ constructEvent: () => event("payment_intent.succeeded", {}) });
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(calls.length, 0);
  assert.equal(await order(), null);
});

test("a completed session that is not yet paid waits instead of provisioning", async () => {
  const { send, calls, order } = setup({
    constructEvent: () => event("checkout.session.completed", session({ payment_status: "unpaid" })),
  });
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, awaiting_payment: true });
  assert.equal(calls.length, 0);
  assert.equal(await order(), null, "no order is recorded until the payment settles");
});

test("a completed, paid session is provisioned from the snapshot and recorded", async () => {
  const { send, calls, order } = setup({ constructEvent: () => event("checkout.session.completed") });
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.deepEqual(calls, [{
    providerPlanId: "fixture-plan",
    referenceId: SESSION_ID,
    customerEmail: "buyer@example.com",
  }]);

  const record = await order();
  assert.equal(record?.status, "provisioned");
  assert.deepEqual(record?.esim, provisioned);
  assert.equal(record?.attempts, 1);
  assert.equal(record?.error, null);
  assert.equal(record?.claimedAt, null, "the lease is released on success");
  assert.equal(record?.sku, item.sku);
  assert.equal(record?.amountTotal, 1200);
  assert.equal(record?.currency, "usd");
  assert.equal(record?.customerEmail, "buyer@example.com");
});

test("no_payment_required is provisioned the same as paid", async () => {
  const { send, calls } = setup({
    constructEvent: () =>
      event("checkout.session.completed", session({ payment_status: "no_payment_required" })),
  });
  assert.equal((await send()).status, 200);
  assert.equal(calls.length, 1);
});

test("async_payment_succeeded provisions a delayed payment method", async () => {
  const { send, calls, order } = setup({
    constructEvent: () => event("checkout.session.async_payment_succeeded"),
  });
  assert.equal((await send()).status, 200);
  assert.equal(calls.length, 1);
  assert.equal((await order())?.status, "provisioned");
});

test("async_payment_failed is logged and never provisions", async () => {
  const { send, calls, order } = setup({
    constructEvent: () =>
      event("checkout.session.async_payment_failed", session({ payment_status: "unpaid" })),
  });
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, error: "payment_failed" });
  assert.equal(calls.length, 0);
  assert.equal(await order(), null);
});

test("the plan sold wins over a catalogue that changed after checkout", async () => {
  // The row was deactivated (say, a provider outage) between checkout and
  // payment. findSku no longer finds it, but the session carries the snapshot.
  const { send, calls } = setup({
    constructEvent: () => event("checkout.session.completed"),
    findSku: () => undefined,
  });
  assert.equal((await send()).status, 200);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { providerPlanId: string }).providerPlanId, "fixture-plan");
});

test("a session with no snapshot falls back to the catalogue", async () => {
  // Sessions created before api/checkout wrote providerPlanId into metadata.
  const { send, calls } = setup({
    constructEvent: () => event("checkout.session.completed", session({ metadata: { sku: item.sku } })),
  });
  assert.equal((await send()).status, 200);
  assert.equal((calls[0] as { providerPlanId: string }).providerPlanId, "fixture-plan");
});

test("a paid session with no resolvable plan is recorded as failed, not retried", async () => {
  const { send, calls, order } = setup({
    constructEvent: () => event("checkout.session.completed", session({ metadata: { sku: "deleted-plan" } })),
  });
  const response = await send();
  assert.equal(response.status, 200, "retrying cannot conjure a plan; this needs a human");
  assert.deepEqual(await response.json(), { received: true, error: "unknown_sku" });
  assert.equal(calls.length, 0);

  const record = await order();
  assert.equal(record?.status, "failed", "the order page must be able to show this");
  assert.equal(record?.error, "unknown_sku");
  assert.equal(record?.claimedAt, null);
});

test("after a success, a duplicate delivery of the same session is skipped", async () => {
  const { send, calls, order } = setup({ constructEvent: () => event("checkout.session.completed") });
  assert.equal((await send()).status, 200);
  assert.equal(calls.length, 1);

  const duplicate = await send();
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { received: true, duplicate: true });
  assert.equal(calls.length, 1);
  assert.equal((await order())?.attempts, 1, "a skipped duplicate is not an attempt");
});

test("a provisioning failure returns non-2xx and records a failed order with the reason", async () => {
  const { send, calls, order, failNextOrder } = setup({
    constructEvent: () => event("checkout.session.completed"),
  });
  failNextOrder();
  const response = await send();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { received: true, error: "provisioning_failed" });
  assert.equal(calls.length, 1);

  const record = await order();
  assert.equal(record?.status, "failed");
  assert.equal(record?.error, "provider outage");
  assert.equal(record?.esim, null);
  assert.equal(record?.attempts, 1);
  assert.equal(record?.claimedAt, null, "a failed attempt releases the lease immediately");
});

test("after a provisioning failure, Stripe's retry of the same event reaches createOrder again", async () => {
  const { send, calls, order, failNextOrder } = setup({
    constructEvent: () => event("checkout.session.completed"),
  });
  failNextOrder();
  assert.equal((await send()).status, 500);
  assert.equal(calls.length, 1);

  const retry = await send();
  assert.equal(retry.status, 200);
  assert.equal(calls.length, 2);

  const record = await order();
  assert.equal(record?.status, "provisioned");
  assert.equal(record?.attempts, 2);
  assert.equal(record?.error, null, "a later success clears the earlier failure");
});

test("two concurrent deliveries buy exactly one eSIM; the loser gets a 409 to retry later", async () => {
  const { send, calls, order, blockNextOrder, releaseOrder } = setup({
    constructEvent: () => event("checkout.session.completed"),
  });
  blockNextOrder();
  const first = send();
  await new Promise((r) => setTimeout(r, 0)); // let the first delivery take the lease
  const second = await send();
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { received: true, in_flight: true });
  assert.equal(calls.length, 1, "the second delivery never reached the provider");

  releaseOrder();
  assert.equal((await first).status, 200);
  assert.equal((await order())?.status, "provisioned");

  const third = await send();
  assert.deepEqual(await third.json(), { received: true, duplicate: true });
  assert.equal(calls.length, 1);
});

test("a provisioning call that outlives its lease cannot fail the order another attempt provisioned", async () => {
  // The bug Codex found in cross-model review: a lease bounds ownership, not
  // the provider call. Attempt A overruns, B takes over and succeeds, then A
  // throws — and without a fence A's failure would hide the customer's QR and
  // re-open the order for a third purchase.
  const { send, calls, order, blockNextOrder, releaseOrder, advance } = setup({
    constructEvent: () => event("checkout.session.completed"),
  });
  blockNextOrder();
  const slow = send();
  await new Promise((r) => setTimeout(r, 0));

  advance(DEFAULT_LEASE_MS);
  const takeover = await send();
  assert.equal(takeover.status, 200);
  assert.equal((await order())?.status, "provisioned");

  releaseOrder("reject");
  const late = await slow;
  assert.equal(late.status, 200, "a superseded attempt must not ask Stripe to retry a settled order");
  assert.deepEqual(await late.json(), { received: true, superseded: true });
  assert.equal(calls.length, 2);

  const record = await order();
  assert.equal(record?.status, "provisioned", "the customer keeps the eSIM they paid for");
  assert.deepEqual(record?.esim, provisioned);
  assert.equal(record?.error, null);
});

test("an eSIM bought by a superseded attempt is reported as orphaned, not written over the live one", async () => {
  const { send, order, blockNextOrder, releaseOrder, advance } = setup({
    constructEvent: () => event("checkout.session.completed"),
  });
  blockNextOrder();
  const slow = send();
  await new Promise((r) => setTimeout(r, 0));

  advance(DEFAULT_LEASE_MS);
  await send();

  releaseOrder("resolve"); // A's provider call succeeds too — two eSIMs, one payment
  const late = await slow;
  assert.deepEqual(await late.json(), { received: true, superseded: true });
  assert.deepEqual((await order())?.esim, provisioned, "the shown eSIM is the winner's");
});

test("a pending order whose lease expired (a crashed attempt) is retried, not treated as in flight", async () => {
  const { send, calls, order, blockNextOrder, advance } = setup({
    constructEvent: () => event("checkout.session.completed"),
  });
  blockNextOrder();
  void send(); // takes the lease and hangs forever — a dead instance
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await order())?.status, "pending");

  advance(DEFAULT_LEASE_MS);
  const retry = await send();
  assert.equal(retry.status, 200);
  assert.equal(calls.length, 2);
  const record = await order();
  assert.equal(record?.status, "provisioned");
  assert.equal(record?.attempts, 2);
});
