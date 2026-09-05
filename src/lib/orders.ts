import type { OrderResult } from "./providers/types.ts";

/**
 * Order state, keyed on the Stripe Checkout Session id.
 *
 * This is the seam between "a customer paid" and "a customer has an eSIM".
 * The webhook writes it, the order page reads it, and it is the idempotency
 * guard: `claim` hands ownership of provisioning to exactly one attempt at a
 * time, so two concurrent Stripe deliveries — same instance or not — cannot
 * both buy an eSIM for one payment.
 *
 * A lease alone is not enough. A slow provider call can outlive its lease, so
 * by the time it returns another attempt may already own — and may already
 * have settled — the order. Every terminal write therefore carries the
 * `claimId` it was issued, and a write from a superseded attempt is rejected
 * rather than applied. Without that fence, a late failure can flip a
 * provisioned order back to `failed`, hiding a QR the customer paid for and
 * re-opening the order for a third purchase.
 *
 * Fields are a snapshot of what was sold at the moment of payment. The live
 * catalogue can change afterwards — a price edit, a row deactivated for a
 * provider outage — and none of that may alter what this customer gets.
 */
export type OrderStatus = "pending" | "provisioned" | "failed";

export interface OrderRecord {
  sessionId: string;
  sku: string;
  providerPlanId: string;
  customerEmail: string | null;
  /** What Stripe collected, in the currency's minor units, as Stripe reported it. */
  amountTotal: number | null;
  currency: string | null;
  status: OrderStatus;
  esim: OrderResult | null;
  /** Why the last attempt failed. Shown to support, never verbatim to the buyer. */
  error: string | null;
  attempts: number;
  /** Identifies the attempt holding the lease. Null once the order settles. */
  claimId: string | null;
  /** When the current `pending` attempt took the lease; null once it settles. */
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrderSnapshot = Pick<
  OrderRecord,
  "sessionId" | "sku" | "providerPlanId" | "customerEmail" | "amountTotal" | "currency"
>;

export type ClaimResult =
  /** The caller owns provisioning and must `complete` or `fail` with this id. */
  | { kind: "claimed"; claimId: string; record: OrderRecord }
  /** Already done — a duplicate delivery. Do nothing. */
  | { kind: "provisioned"; record: OrderRecord }
  /** Another attempt holds a live lease. Come back later. */
  | { kind: "in_flight"; record: OrderRecord };

export type WriteResult =
  | { kind: "written"; record: OrderRecord }
  /**
   * A newer attempt owns this order; nothing was written. For a `complete`
   * this means an eSIM was bought that nobody will be shown — real money that
   * needs reconciling, so the caller must shout about it.
   */
  | { kind: "superseded"; record: OrderRecord };

export interface OrderStore {
  get(sessionId: string): Promise<OrderRecord | null>;
  /**
   * Atomically take ownership of provisioning. Creates the record on first
   * sight; re-claims a `failed` order or a `pending` one whose lease has
   * expired (a crashed or overrunning attempt); refuses a `provisioned` one
   * or a live lease.
   */
  claim(snapshot: OrderSnapshot, leaseMs: number): Promise<ClaimResult>;
  complete(sessionId: string, claimId: string, esim: OrderResult): Promise<WriteResult>;
  fail(sessionId: string, claimId: string, error: string): Promise<WriteResult>;
  close?(): void;
}

/**
 * How long one provisioning attempt may hold the lease.
 *
 * Long enough that a healthy provider call finishes inside it, short enough
 * that a dead instance does not strand a paid order. An attempt that overruns
 * is not lost: it loses ownership, its terminal write is fenced off, and the
 * attempt that reclaimed the order decides the outcome.
 */
export const DEFAULT_LEASE_MS = 2 * 60_000;

export interface StoreOptions {
  /** Injectable clock, for tests that need to age a lease. */
  now?: () => number;
  /** Injectable id source, so tests can assert on specific claim ids. */
  newClaimId?: () => string;
}

/** Shared claim decision, so both implementations agree to the letter. */
export function decideClaim(
  existing: OrderRecord | null,
  snapshot: OrderSnapshot,
  leaseMs: number,
  nowMs: number,
  claimId: string,
): ClaimResult {
  const now = new Date(nowMs).toISOString();
  if (!existing) {
    return {
      kind: "claimed",
      claimId,
      record: {
        ...snapshot,
        status: "pending",
        esim: null,
        error: null,
        attempts: 1,
        claimId,
        claimedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    };
  }
  if (existing.status === "provisioned") return { kind: "provisioned", record: existing };
  if (
    existing.status === "pending" &&
    existing.claimedAt !== null &&
    nowMs - Date.parse(existing.claimedAt) < leaseMs
  ) {
    return { kind: "in_flight", record: existing };
  }
  return {
    kind: "claimed",
    claimId,
    record: {
      ...existing,
      // The snapshot may be richer than what an older record captured.
      providerPlanId: snapshot.providerPlanId || existing.providerPlanId,
      customerEmail: snapshot.customerEmail ?? existing.customerEmail,
      amountTotal: snapshot.amountTotal ?? existing.amountTotal,
      currency: snapshot.currency ?? existing.currency,
      status: "pending",
      attempts: existing.attempts + 1,
      claimId,
      claimedAt: now,
      updatedAt: now,
    },
  };
}

/**
 * In-memory store. Correct for a single long-lived process (`next dev`, one
 * container) and NOTHING ELSE: serverless instances do not share memory, so
 * on a multi-instance deploy the order page cannot see what the webhook wrote
 * and a Stripe retry on another instance can double-provision. `claim` is
 * atomic here only because nothing in it awaits.
 */
export function createMemoryOrderStore(options: StoreOptions = {}): OrderStore {
  const now = options.now ?? Date.now;
  const newClaimId = options.newClaimId ?? (() => crypto.randomUUID());
  const orders = new Map<string, OrderRecord>();
  const must = (sessionId: string): OrderRecord => {
    const record = orders.get(sessionId);
    if (!record) throw new Error(`order ${sessionId} does not exist`);
    return record;
  };
  const settle = (
    sessionId: string,
    claimId: string,
    fields: Partial<OrderRecord>,
  ): WriteResult => {
    const record = must(sessionId);
    // Fence: only the attempt that currently holds the lease may settle it.
    if (record.claimId !== claimId) return { kind: "superseded", record: structuredClone(record) };
    Object.assign(record, fields, {
      claimId: null,
      claimedAt: null,
      updatedAt: new Date(now()).toISOString(),
    });
    return { kind: "written", record: structuredClone(record) };
  };
  return {
    async get(sessionId) {
      const record = orders.get(sessionId);
      return record ? structuredClone(record) : null;
    },
    async claim(snapshot, leaseMs) {
      const result = decideClaim(
        orders.get(snapshot.sessionId) ?? null,
        snapshot,
        leaseMs,
        now(),
        newClaimId(),
      );
      if (result.kind === "claimed") {
        orders.set(snapshot.sessionId, structuredClone(result.record));
        return { kind: "claimed", claimId: result.claimId, record: structuredClone(result.record) };
      }
      return { kind: result.kind, record: structuredClone(result.record) };
    },
    async complete(sessionId, claimId, esim) {
      return settle(sessionId, claimId, {
        status: "provisioned",
        esim: structuredClone(esim),
        error: null,
      });
    },
    async fail(sessionId, claimId, error) {
      return settle(sessionId, claimId, { status: "failed", error });
    },
  };
}

let shared: Promise<OrderStore> | null = null;

/**
 * The process-wide store. `ORDER_STORE_PATH=/data/orders.sqlite` selects the
 * durable SQLite store (single container / VPS deploys); unset falls back to
 * memory, which is only acceptable in development. Lazy so nothing touches it until a request needs it.
 */
export function getOrderStore(): Promise<OrderStore> {
  if (!shared) {
    shared = (async () => {
      const path = process.env.ORDER_STORE_PATH;
      if (path) {
        const { openSqliteOrderStore } = await import("./orders-sqlite.ts");
        return openSqliteOrderStore(path);
      }
      if (process.env.NODE_ENV === "production") {
        console.warn(
          "[orders] ORDER_STORE_PATH is unset — using the in-memory store. Orders will not survive a restart and are invisible to other instances.",
        );
      }
      return createMemoryOrderStore();
    })();
    // A failed open (volume not mounted yet, bad path) must not be cached, or
    // every request until restart inherits the same rejection.
    shared.catch(() => {
      shared = null;
    });
  }
  return shared;
}
