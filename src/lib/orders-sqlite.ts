import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decideClaim,
  type OrderRecord,
  type OrderStore,
  type StoreOptions,
  type WriteResult,
} from "./orders.ts";
import type { OrderResult } from "./providers/types.ts";

/**
 * Durable order store on Node's built-in SQLite — no native dependency to
 * compile, one file on disk, and `BEGIN IMMEDIATE` makes `claim` and the
 * fenced terminal writes atomic across every process that shares that file.
 * Right for a single container or VPS. A serverless deploy has no shared disk
 * and needs a hosted database behind the same `OrderStore` interface instead.
 */

interface Row {
  session_id: string;
  sku: string;
  provider_plan_id: string;
  customer_email: string | null;
  amount_total: number | null;
  currency: string | null;
  status: OrderRecord["status"];
  esim: string | null;
  error: string | null;
  attempts: number;
  claim_id: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: Row): OrderRecord {
  return {
    sessionId: row.session_id,
    sku: row.sku,
    providerPlanId: row.provider_plan_id,
    customerEmail: row.customer_email,
    amountTotal: row.amount_total,
    currency: row.currency,
    status: row.status,
    esim: row.esim ? (JSON.parse(row.esim) as OrderResult) : null,
    error: row.error,
    attempts: row.attempts,
    claimId: row.claim_id,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openSqliteOrderStore(path: string, options: StoreOptions = {}): OrderStore {
  const now = options.now ?? Date.now;
  const newClaimId = options.newClaimId ?? (() => crypto.randomUUID());
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS orders (
      session_id       TEXT PRIMARY KEY,
      sku              TEXT NOT NULL,
      provider_plan_id TEXT NOT NULL,
      customer_email   TEXT,
      amount_total     INTEGER,
      currency         TEXT,
      status           TEXT NOT NULL CHECK (status IN ('pending', 'provisioned', 'failed')),
      esim             TEXT,
      error            TEXT,
      attempts         INTEGER NOT NULL DEFAULT 0,
      claim_id         TEXT,
      claimed_at       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
  `);
  // Files written before terminal writes were fenced predate claim_id.
  const columns = db.prepare("PRAGMA table_info(orders)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "claim_id")) {
    db.exec("ALTER TABLE orders ADD COLUMN claim_id TEXT");
  }

  const selectOne = db.prepare("SELECT * FROM orders WHERE session_id = ?");
  const upsert = db.prepare(`
    INSERT INTO orders (session_id, sku, provider_plan_id, customer_email, amount_total, currency,
                        status, esim, error, attempts, claim_id, claimed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      sku = excluded.sku, provider_plan_id = excluded.provider_plan_id,
      customer_email = excluded.customer_email, amount_total = excluded.amount_total,
      currency = excluded.currency, status = excluded.status, esim = excluded.esim,
      error = excluded.error, attempts = excluded.attempts, claim_id = excluded.claim_id,
      claimed_at = excluded.claimed_at, updated_at = excluded.updated_at
  `);

  const write = (r: OrderRecord) =>
    upsert.run(
      r.sessionId, r.sku, r.providerPlanId, r.customerEmail, r.amountTotal, r.currency,
      r.status, r.esim ? JSON.stringify(r.esim) : null, r.error, r.attempts, r.claimId,
      r.claimedAt, r.createdAt, r.updatedAt,
    );

  const read = (sessionId: string): OrderRecord | null => {
    const row = selectOne.get(sessionId) as Row | undefined;
    return row ? toRecord(row) : null;
  };

  /**
   * Read, check the fence and write under one write lock, so a superseded
   * attempt cannot slip its terminal write between another process's check
   * and update.
   */
  const settle = (sessionId: string, claimId: string, fields: Partial<OrderRecord>): WriteResult => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const record = read(sessionId);
      if (!record) throw new Error(`order ${sessionId} does not exist`);
      if (record.claimId !== claimId) {
        db.exec("COMMIT");
        return { kind: "superseded", record };
      }
      const updated: OrderRecord = {
        ...record,
        ...fields,
        claimId: null,
        claimedAt: null,
        updatedAt: new Date(now()).toISOString(),
      };
      write(updated);
      db.exec("COMMIT");
      return { kind: "written", record: updated };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  return {
    async get(sessionId) {
      return read(sessionId);
    },
    async claim(snapshot, leaseMs) {
      // IMMEDIATE takes the write lock up front, so the read-decide-write below
      // cannot interleave with another process's claim on the same session.
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = decideClaim(
          read(snapshot.sessionId),
          snapshot,
          leaseMs,
          now(),
          newClaimId(),
        );
        if (result.kind === "claimed") write(result.record);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async complete(sessionId, claimId, esim) {
      return settle(sessionId, claimId, { status: "provisioned", esim, error: null });
    },
    async fail(sessionId, claimId, error) {
      return settle(sessionId, claimId, { status: "failed", error });
    },
    close() {
      db.close();
    },
  };
}
