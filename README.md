# stripe-fulfilment-kit

Idempotent fulfilment for Stripe webhooks: leased, **fenced** order claims that
survive retries, crashes, slow providers and concurrent deliveries.

The hard part of taking payments isn't taking the payment. It's making sure that
when Stripe retries — and it will, sometimes to two instances at once — you
don't deliver twice, charge twice, or lose an order that was already paid for.

```
npm install && npm test     # 59 tests, no network, no Stripe account needed
```

**Full write-up of the bug, how 78 tests missed it, and the fix:**
[CASE-STUDY.md](CASE-STUDY.md)

## The bug this exists to prevent

Provisioning takes ownership of an order with a two-minute lease, so two
concurrent deliveries of the same event can't both fulfil it. That is not
enough. **A lease bounds how long an attempt owns the order. It does not reach
into the provider and stop a call that is already in flight.**

```
        0:00                     2:00 lease expires              2:40
          │                            │                           │
 A   ├─── claims ─── provider call hangs ─────────────────────► throws
                                                                    └─► writes "failed" ✗
 B                                ├── reclaims ── succeeds ──► "provisioned" ✓
```

B fulfils the order correctly. Then A's dead call finally throws, and its
failure lands *on top of* B's success. Three things then go wrong:

1. The customer's delivered product disappears from their order page.
2. The order is marked failed, so it becomes claimable again — the next retry
   buys and charges a **third** time.
3. Support sees a failed order, accounting sees a successful charge, and nobody
   sees the item that was actually delivered.

## The fix: fencing tokens

`claim()` issues a token. Both terminal writes require it, and a write from a
superseded attempt changes nothing and says so.

```ts
const settle = (sessionId: string, claimId: string, fields: Partial<OrderRecord>) => {
  const record = must(sessionId);
  // Fence: only the attempt that currently holds the lease may settle it.
  if (record.claimId !== claimId) return { kind: "superseded", record };
  Object.assign(record, fields, { claimId: null, claimedAt: null });
  return { kind: "written", record };
};
```

In the SQLite store the same check runs inside `BEGIN IMMEDIATE`, so the fence
holds across processes, not just within one.

## What the webhook handler does

- **Verifies the signature.** An unverified endpoint is a free-goods dispenser.
- **Gates on `payment_status`.** Delayed payment methods fire
  `checkout.session.completed` while still `unpaid`; the real answer arrives as
  `async_payment_succeeded` / `_failed`. Fulfilling on `completed` alone ships
  goods before — or despite — the charge settling.
- **Claims before working.** A live lease returns `409` so Stripe retries later.
  A `provisioned` order returns `200 duplicate`. A `failed` order or an expired
  lease is retried.
- **Never swallows a failure.** Provisioning throws → `500`, so Stripe retries.
  Returning `200` on failure tells Stripe it succeeded and it never tries again,
  silently stranding a customer who paid.
- **Reports orphans loudly.** If a superseded attempt's purchase *succeeded*,
  that's a second item bought for one payment — logged with both order ids,
  because a human has to reconcile it.

## Storage

`OrderStore` is four methods: `get`, `claim`, `complete`, `fail`. Two
implementations ship, and one behavioural test suite runs against both so they
cannot drift:

- **in-memory** — development only; per-process, invisible to other instances
- **SQLite** (`node:sqlite`, no native dependency) — durable, `BEGIN IMMEDIATE`
  for cross-process atomicity, one file on disk

A hosted database is a third file behind the same interface.

## Tests

59 tests, all offline. The ones that matter are the writes that arrive *after
ownership has moved on* — the case a lease exists to create, and the one that
tests written the obvious way never cover:

```
a stale failure cannot undo a provisioned order
a stale completion cannot overwrite the item the customer was shown
a stale write is rejected even when the newer attempt failed
a provisioning call that outlives its lease cannot fail the order another attempt provisioned
an item bought by a superseded attempt is reported as orphaned, not written over the live one
two concurrent deliveries buy exactly one item; the loser gets a 409 to retry later
sqlite: a stale write from another process is fenced off
concurrent claims for one session yield exactly one owner
a file written before fencing gains claim_id without losing its orders
```

## Provenance

Extracted from a storefront I built. The fencing bug was real: I shipped the
lease without the fence, 78 tests passed over it, and a cross-model review
caught it — every one of those tests settled an order from its *current* owner,
so none covered a write from a superseded one.

MIT.
