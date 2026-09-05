# A lease that passed 78 tests and still lost a customer's order

A payment fulfilment race condition: what it was, how it hid from a full test
suite, and what it would have cost.

---

## The setup

Provisioning takes ownership of an order with a two-minute lease, so two
concurrent deliveries of the same Stripe event cannot both fulfil it. Standard
pattern. It passed 78 tests, including concurrency tests.

It was still wrong.

## The bug

**A lease bounds how long an attempt *owns* the order. It does not reach into
the provider and stop a call that is already in flight.**

```
        0:00                     2:00 lease expires              2:40
          │                            │                           │
 A   ├─── claims ─── provider call hangs ─────────────────────► throws
                                                                    └─► writes "failed" ✗
 B                                ├── reclaims ── succeeds ──► "provisioned" ✓
```

Attempt B does the job correctly. Then attempt A's dead call finally throws,
and its failure lands *on top of* B's success.

## What it costs

1. The customer's delivered product disappears from their order page and is
   replaced with "we couldn't issue this".
2. The order is marked failed, so it becomes claimable again — the next retry
   buys and charges a **third** time.
3. Support sees a failed order. Accounting sees a successful charge. Nobody
   sees the item that was actually delivered.

## Why 78 tests missed it

Every test settled an order from the attempt that **currently owned** it.

The uncovered case was a write arriving from an owner that had *already been
replaced* — which is precisely the state a lease exists to create. The tests
covered the mechanism working. They never covered the mechanism being
superseded.

This is the general lesson, and it transfers to any lock or lease: **test the
write that arrives after ownership has moved on.**

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

The webhook then handles *losing* properly:

- A stale **failure** returns `200` — never ask Stripe to retry an order that
  is already settled.
- A stale **success** logs a loud reconciliation warning with both provider
  order ids. That path means a second item really was purchased for one
  payment, and a human has to unwind it.

## The 14 tests that hold it shut

Written against both storage backends so the two cannot drift:

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

78 tests before. 92 after.

## How it was found

Cross-model review. A second model (OpenAI Codex) was run over the code as an
adversarial reviewer, reproduced the failure with the injectable clock, and
reported it before it ever reached production.

That is now standard practice for me on anything touching money: a second
model, from a different family, reviewing with a mandate to find the failure
rather than approve the work.

## The code

Full implementation, both stores, all tests:
**https://github.com/GG5533/stripe-fulfilment-kit**

---

*Sami Habbal — I make AI and payment systems survive production.
[github.com/GG5533](https://github.com/GG5533)*
