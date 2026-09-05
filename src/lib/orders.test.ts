import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryOrderStore,
  DEFAULT_LEASE_MS,
  getOrderStore,
  type ClaimResult,
  type OrderSnapshot,
  type OrderStore,
} from "./orders.ts";
import { openSqliteOrderStore } from "./orders-sqlite.ts";

const snapshot: OrderSnapshot = {
  sessionId: "cs_test_1",
  sku: "test-plan",
  providerPlanId: "fixture-plan",
  customerEmail: "buyer@example.com",
  amountTotal: 1200,
  currency: "usd",
};

const esim = {
  providerOrderId: "order-1",
  activationCode: "LPA:1$rsp.example.com$FIXTURE",
  qrPayload: "LPA:1$rsp.example.com$FIXTURE",
};

/** A clock the tests can move, so a lease can be aged without sleeping. */
function clock(start = Date.parse("2026-09-05T00:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Claim and hand back the fencing token, asserting the claim actually succeeded. */
async function claimed(store: OrderStore, snap: OrderSnapshot = snapshot): Promise<string> {
  const result = await store.claim(snap, DEFAULT_LEASE_MS);
  assert.equal(result.kind, "claimed");
  return (result as Extract<ClaimResult, { kind: "claimed" }>).claimId;
}

// The same behavioural suite runs against every implementation: the contract
// is what the webhook relies on, and the two must not drift.
const implementations: [string, (now: () => number) => { store: OrderStore; cleanup: () => void }][] = [
  ["memory", (now) => ({ store: createMemoryOrderStore({ now }), cleanup: () => {} })],
  ["sqlite", (now) => {
    const dir = mkdtempSync(join(tmpdir(), "esim-orders-"));
    const store = openSqliteOrderStore(join(dir, "nested", "orders.sqlite"), { now });
    return { store, cleanup: () => { store.close?.(); rmSync(dir, { recursive: true, force: true }); } };
  }],
];

for (const [name, make] of implementations) {
  const suite = (title: string, fn: (store: OrderStore, c: ReturnType<typeof clock>) => Promise<void>) =>
    test(`${name}: ${title}`, async () => {
      const c = clock();
      const { store, cleanup } = make(c.now);
      try { await fn(store, c); } finally { cleanup(); }
    });

  suite("get returns null for an unknown session", async (store) => {
    assert.equal(await store.get("cs_test_missing"), null);
  });

  suite("first claim creates a pending order with one attempt and a live lease", async (store, c) => {
    const claimId = await claimed(store);
    const record = await store.get(snapshot.sessionId);
    assert.equal(record?.status, "pending");
    assert.equal(record?.attempts, 1);
    assert.equal(record?.esim, null);
    assert.equal(record?.error, null);
    assert.equal(record?.claimId, claimId);
    assert.equal(record?.claimedAt, new Date(c.now()).toISOString());
    assert.equal(record?.createdAt, record?.updatedAt);
    assert.equal(record?.sku, snapshot.sku);
    assert.equal(record?.amountTotal, 1200);
  });

  suite("a second claim while the lease is live is in_flight and does not bump attempts", async (store, c) => {
    await claimed(store);
    c.advance(DEFAULT_LEASE_MS - 1);
    const again = await store.claim(snapshot, DEFAULT_LEASE_MS);
    assert.equal(again.kind, "in_flight");
    assert.equal((await store.get(snapshot.sessionId))?.attempts, 1);
  });

  suite("a claim after the lease expired re-claims a crashed attempt with a fresh token", async (store, c) => {
    const first = await claimed(store);
    c.advance(DEFAULT_LEASE_MS);
    const second = await claimed(store);
    assert.notEqual(second, first, "a re-claim must invalidate the old token");
    const record = await store.get(snapshot.sessionId);
    assert.equal(record?.attempts, 2);
    assert.equal(record?.claimId, second);
  });

  suite("complete marks provisioned, stores the eSIM and releases the lease", async (store) => {
    const claimId = await claimed(store);
    const done = await store.complete(snapshot.sessionId, claimId, esim);
    assert.equal(done.kind, "written");
    assert.equal(done.record.status, "provisioned");
    assert.deepEqual(done.record.esim, esim);
    assert.equal(done.record.claimId, null);
    assert.equal(done.record.claimedAt, null);
    assert.deepEqual(await store.get(snapshot.sessionId), done.record);
  });

  suite("a provisioned order refuses every later claim", async (store, c) => {
    const claimId = await claimed(store);
    await store.complete(snapshot.sessionId, claimId, esim);
    c.advance(DEFAULT_LEASE_MS * 10);
    const again = await store.claim(snapshot, DEFAULT_LEASE_MS);
    assert.equal(again.kind, "provisioned");
    assert.deepEqual(again.record.esim, esim);
    assert.equal((await store.get(snapshot.sessionId))?.attempts, 1);
  });

  suite("fail records the reason, releases the lease, and allows an immediate re-claim", async (store) => {
    const claimId = await claimed(store);
    const failed = await store.fail(snapshot.sessionId, claimId, "provider outage");
    assert.equal(failed.kind, "written");
    assert.equal(failed.record.status, "failed");
    assert.equal(failed.record.error, "provider outage");
    assert.equal(failed.record.claimId, null);

    const again = await store.claim(snapshot, DEFAULT_LEASE_MS);
    assert.equal(again.kind, "claimed");
    assert.equal(again.record.attempts, 2);
    assert.equal(again.record.status, "pending");
  });

  suite("a later success clears the earlier failure", async (store) => {
    const first = await claimed(store);
    await store.fail(snapshot.sessionId, first, "provider outage");
    const second = await claimed(store);
    const done = await store.complete(snapshot.sessionId, second, esim);
    assert.equal(done.record.error, null);
    assert.equal(done.record.attempts, 2);
  });

  // ------------------------------------------------------------ the fence
  // A lease bounds how long an attempt OWNS the order; it cannot stop a slow
  // provider call from returning afterwards. These are the writes that must
  // not land. Found by Codex in cross-model review of the unfenced version.

  suite("a stale failure cannot undo a provisioned order", async (store, c) => {
    const slow = await claimed(store); // attempt A starts, then overruns
    c.advance(DEFAULT_LEASE_MS);
    const fresh = await claimed(store); // attempt B re-claims and succeeds
    await store.complete(snapshot.sessionId, fresh, esim);

    const stale = await store.fail(snapshot.sessionId, slow, "provider outage");
    assert.equal(stale.kind, "superseded");

    const record = await store.get(snapshot.sessionId);
    assert.equal(record?.status, "provisioned", "the customer's eSIM must survive");
    assert.deepEqual(record?.esim, esim);
    assert.equal(record?.error, null);
    // ...and the order must not have been re-opened for a third purchase.
    assert.equal((await store.claim(snapshot, DEFAULT_LEASE_MS)).kind, "provisioned");
  });

  suite("a stale completion cannot overwrite the eSIM the customer was shown", async (store, c) => {
    const slow = await claimed(store);
    c.advance(DEFAULT_LEASE_MS);
    const fresh = await claimed(store);
    await store.complete(snapshot.sessionId, fresh, esim);

    const orphan = { ...esim, providerOrderId: "order-2", activationCode: "LPA:1$rsp$ORPHAN" };
    const stale = await store.complete(snapshot.sessionId, slow, orphan);
    assert.equal(stale.kind, "superseded");
    assert.deepEqual((await store.get(snapshot.sessionId))?.esim, esim);
  });

  suite("a stale write is rejected even when the newer attempt failed", async (store, c) => {
    const slow = await claimed(store);
    c.advance(DEFAULT_LEASE_MS);
    const fresh = await claimed(store);
    await store.fail(snapshot.sessionId, fresh, "newer failure");

    const stale = await store.complete(snapshot.sessionId, slow, esim);
    assert.equal(stale.kind, "superseded");
    assert.equal((await store.get(snapshot.sessionId))?.error, "newer failure");
  });

  suite("a settled order rejects a second write from the same token", async (store) => {
    const claimId = await claimed(store);
    await store.complete(snapshot.sessionId, claimId, esim);
    const again = await store.fail(snapshot.sessionId, claimId, "late error");
    assert.equal(again.kind, "superseded");
    assert.equal((await store.get(snapshot.sessionId))?.status, "provisioned");
  });

  suite("an unknown token is rejected outright", async (store) => {
    await claimed(store);
    const bogus = await store.complete(snapshot.sessionId, "not-a-real-claim", esim);
    assert.equal(bogus.kind, "superseded");
    assert.equal((await store.get(snapshot.sessionId))?.status, "pending");
  });

  // -------------------------------------------------------------------------

  suite("a re-claim fills in fields an older record lacked, never blanks ones it had", async (store) => {
    const first = await claimed(store, { ...snapshot, providerPlanId: "", customerEmail: null, amountTotal: null, currency: null });
    await store.fail(snapshot.sessionId, first, "unknown_sku");
    const again = await store.claim(snapshot, DEFAULT_LEASE_MS);
    assert.equal(again.record.providerPlanId, "fixture-plan");
    assert.equal(again.record.customerEmail, "buyer@example.com");

    await store.fail(snapshot.sessionId, (again as Extract<ClaimResult, { kind: "claimed" }>).claimId, "again");
    const third = await store.claim({ ...snapshot, providerPlanId: "", customerEmail: null }, DEFAULT_LEASE_MS);
    assert.equal(third.record.providerPlanId, "fixture-plan");
    assert.equal(third.record.customerEmail, "buyer@example.com");
  });

  suite("complete and fail on an unknown session throw rather than inventing an order", async (store) => {
    await assert.rejects(() => store.complete("cs_test_missing", "any", esim), /does not exist/);
    await assert.rejects(() => store.fail("cs_test_missing", "any", "x"), /does not exist/);
  });

  suite("concurrent claims for one session yield exactly one owner", async (store) => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => store.claim(snapshot, DEFAULT_LEASE_MS)),
    );
    const kinds = results.map((r) => r.kind);
    assert.equal(kinds.filter((k) => k === "claimed").length, 1, kinds.join(","));
    assert.equal(kinds.filter((k) => k === "in_flight").length, 24);
    assert.equal((await store.get(snapshot.sessionId))?.attempts, 1);
  });

  suite("records handed out are copies — mutating them does not change the store", async (store) => {
    const result = await store.claim(snapshot, DEFAULT_LEASE_MS);
    result.record.status = "provisioned";
    const got = await store.get(snapshot.sessionId);
    assert.equal(got?.status, "pending");
    got!.status = "failed";
    assert.equal((await store.get(snapshot.sessionId))?.status, "pending");
  });
}

test("sqlite: orders survive closing and reopening the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "esim-orders-"));
  const path = join(dir, "orders.sqlite");
  try {
    const first = openSqliteOrderStore(path);
    const claimId = await claimed(first);
    await first.complete(snapshot.sessionId, claimId, esim);
    first.close?.();

    const second = openSqliteOrderStore(path);
    const record = await second.get(snapshot.sessionId);
    assert.equal(record?.status, "provisioned");
    assert.deepEqual(record?.esim, esim);
    second.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite: two connections to one file cannot both claim the same session", async () => {
  // Two processes sharing a volume look like this: separate connections, one file.
  const dir = mkdtempSync(join(tmpdir(), "esim-orders-"));
  const path = join(dir, "orders.sqlite");
  try {
    const a = openSqliteOrderStore(path);
    const b = openSqliteOrderStore(path);
    const [ra, rb] = await Promise.all([
      a.claim(snapshot, DEFAULT_LEASE_MS),
      b.claim(snapshot, DEFAULT_LEASE_MS),
    ]);
    assert.deepEqual([ra.kind, rb.kind].sort(), ["claimed", "in_flight"]);
    assert.equal((await b.get(snapshot.sessionId))?.attempts, 1);
    a.close?.();
    b.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite: a stale write from another process is fenced off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "esim-orders-"));
  const path = join(dir, "orders.sqlite");
  const c = clock();
  try {
    const a = openSqliteOrderStore(path, { now: c.now });
    const b = openSqliteOrderStore(path, { now: c.now });
    const slow = await claimed(a); // instance A overruns its lease
    c.advance(DEFAULT_LEASE_MS);
    const fresh = await claimed(b); // instance B takes over and succeeds
    await b.complete(snapshot.sessionId, fresh, esim);

    assert.equal((await a.fail(snapshot.sessionId, slow, "outage")).kind, "superseded");
    assert.equal((await a.get(snapshot.sessionId))?.status, "provisioned");
    a.close?.();
    b.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite: a file written before fencing gains claim_id without losing its orders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "esim-orders-"));
  const path = join(dir, "orders.sqlite");
  try {
    // The pre-fencing schema, as shipped in 4798aa2.
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE orders (
        session_id TEXT PRIMARY KEY, sku TEXT NOT NULL, provider_plan_id TEXT NOT NULL,
        customer_email TEXT, amount_total INTEGER, currency TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'provisioned', 'failed')),
        esim TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, claimed_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO orders VALUES ('cs_test_old', 'sku', 'plan', NULL, 100, 'usd',
        'provisioned', '{"providerOrderId":"old","activationCode":"LPA:1$x$y","qrPayload":"LPA:1$x$y"}',
        NULL, 1, NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);
    legacy.close();

    const store = openSqliteOrderStore(path);
    const record = await store.get("cs_test_old");
    assert.equal(record?.status, "provisioned", "the existing order must still be readable");
    assert.equal(record?.claimId, null);
    assert.equal(record?.esim?.providerOrderId, "old");
    // ...and the migrated file must still fence new writes.
    const claimId = await claimed(store);
    assert.equal((await store.fail(snapshot.sessionId, "bogus", "x")).kind, "superseded");
    assert.equal((await store.fail(snapshot.sessionId, claimId, "real")).kind, "written");
    store.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory: stores are independent — one per process, not one per module import", async () => {
  const a = createMemoryOrderStore();
  const b = createMemoryOrderStore();
  await a.claim(snapshot, DEFAULT_LEASE_MS);
  assert.equal(await b.get(snapshot.sessionId), null);
});

test("getOrderStore does not cache a failed open — a later call can succeed", async () => {
  // ORDER_STORE_PATH under a regular file cannot be created; that rejection
  // must not poison every later request until the process restarts.
  const dir = mkdtempSync(join(tmpdir(), "esim-orders-"));
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  const previous = process.env.ORDER_STORE_PATH;
  try {
    process.env.ORDER_STORE_PATH = join(blocker, "orders.sqlite");
    await assert.rejects(() => getOrderStore());

    delete process.env.ORDER_STORE_PATH;
    const store = await getOrderStore();
    await store.claim(snapshot, DEFAULT_LEASE_MS);
    assert.equal((await store.get(snapshot.sessionId))?.status, "pending");
  } finally {
    if (previous === undefined) delete process.env.ORDER_STORE_PATH;
    else process.env.ORDER_STORE_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
