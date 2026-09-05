import type Stripe from "stripe";
import { DEFAULT_LEASE_MS, type OrderStore } from "./orders.ts";
import type { FulfilmentProvider } from "./providers/types.ts";

/** The catalogue row a session was sold against. Yours will have more fields. */
export interface CatalogItem {
  sku: string;
  providerPlanId?: string;
  active: boolean;
}

export interface WebhookDependencies {
  configured: boolean;
  /** Verify the signature and parse the raw body into a Stripe event. Throws on failure. */
  constructEvent: (rawBody: string, signature: string) => Stripe.Event;
  findSku: (sku: string) => CatalogItem | undefined;
  getProvider: () => FulfilmentProvider;
  /**
   * Order state, also the idempotency guard. `claim` hands ownership of
   * provisioning to exactly one attempt at a time; a `provisioned` order is
   * never bought again, a `failed` one or an expired lease may be retried.
   */
  orders: OrderStore;
  /** How long one attempt may hold the lease. Tests shorten it. */
  leaseMs?: number;
}

/**
 * Stripe webhook — the only place an eSIM is ever bought.
 *
 * Three rules, learned the expensive way by everyone who has built this:
 *
 *  1. VERIFY THE SIGNATURE. An unverified webhook endpoint is a free eSIM
 *     dispenser for anyone who finds the URL.
 *  2. BE IDEMPOTENT, BUT ONLY ON SUCCESS. Stripe retries, sometimes to two
 *     instances at once. `orders.claim` is atomic: one attempt owns the
 *     session, the rest are told to come back. Only a `provisioned` order
 *     blocks a retry for good — blocking on *attempt* would make a failed
 *     provisioning permanently unretryable, defeating rule 3. Every terminal
 *     write carries the claim id it was issued, so an attempt that overran its
 *     lease cannot overwrite the outcome of the attempt that replaced it.
 *  3. NEVER BLOCK, AND NEVER SWALLOW A FAILURE. If provisioning throws, return
 *     a non-2xx so Stripe retries the delivery. A 200 here tells Stripe the
 *     webhook succeeded, so it will never try again — silently stranding a
 *     customer who paid and got nothing.
 *
 * Also gates on `payment_status`: delayed payment methods (bank debits, OXXO,
 * …) fire `checkout.session.completed` while the session is still "unpaid" —
 * the real answer arrives later as `checkout.session.async_payment_succeeded`
 * or `_failed`. Provisioning on `completed` alone would ship an eSIM before,
 * or despite, the charge ever actually settling.
 */
export function createWebhookHandler(deps: WebhookDependencies) {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;

  return async (req: Request): Promise<Response> => {
    if (!deps.configured) {
      return Response.json({ error: "Webhook not configured." }, { status: 503 });
    }

    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return Response.json({ error: "Missing signature." }, { status: 400 });
    }

    const raw = await req.text();

    let event: Stripe.Event;
    try {
      event = deps.constructEvent(raw, signature);
    } catch (err) {
      console.error("[webhook] signature verification failed", err);
      return Response.json({ error: "Invalid signature." }, { status: 400 });
    }

    if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object as Stripe.Checkout.Session;
      // The payment that started this session never went through. Nothing was
      // provisioned — there is nothing to undo, just a fact worth logging.
      console.error("[webhook] async payment failed, nothing was provisioned", {
        session: session.id,
      });
      return Response.json({ received: true, error: "payment_failed" });
    }

    const isCompleted = event.type === "checkout.session.completed";
    const isAsyncSuccess = event.type === "checkout.session.async_payment_succeeded";
    if (!isCompleted && !isAsyncSuccess) {
      return Response.json({ received: true });
    }

    const session = event.data.object as Stripe.Checkout.Session;

    if (
      isCompleted &&
      session.payment_status !== "paid" &&
      session.payment_status !== "no_payment_required"
    ) {
      // A delayed payment method: this session resolves later via
      // async_payment_succeeded/_failed. Provisioning now would be a guess.
      return Response.json({ received: true, awaiting_payment: true });
    }

    const sku = session.metadata?.sku ?? "";
    const customerEmail = session.customer_details?.email ?? null;

    // The plan sold is the one api/checkout snapshotted into the session. The
    // live catalogue may have changed since — a price edit, a row deactivated
    // for a provider outage — and the customer paid for what was sold. So
    // provision from the snapshot, and fall back to the catalogue only for
    // sessions created before the snapshot existed. A plan that is genuinely
    // gone surfaces below as a failed order with a refund path, never as silence.
    const providerPlanId =
      session.metadata?.providerPlanId?.trim() || deps.findSku(sku)?.providerPlanId?.trim() || "";

    const claim = await deps.orders.claim(
      {
        sessionId: session.id,
        sku,
        providerPlanId,
        customerEmail,
        amountTotal: session.amount_total ?? null,
        currency: session.currency ?? null,
      },
      leaseMs,
    );

    if (claim.kind === "provisioned") {
      return Response.json({ received: true, duplicate: true });
    }
    if (claim.kind === "in_flight") {
      // Another attempt is working on it. Non-2xx so Stripe comes back later,
      // by which time it is provisioned (→ duplicate) or failed (→ re-claim).
      return Response.json({ received: true, in_flight: true }, { status: 409 });
    }

    if (!providerPlanId) {
      console.error("[webhook] paid session references unknown sku", { sku, id: session.id });
      await deps.orders.fail(session.id, claim.claimId, "unknown_sku");
      // Retrying cannot conjure a plan; this needs a human and a refund.
      return Response.json({ received: true, error: "unknown_sku" });
    }

    try {
      const provider = deps.getProvider();
      const esim = await provider.createOrder({
        providerPlanId,
        referenceId: session.id,
        customerEmail: customerEmail ?? "",
      });

      const written = await deps.orders.complete(session.id, claim.claimId, esim);
      if (written.kind === "superseded") {
        // We overran our lease, another attempt provisioned first, and we have
        // just bought a second eSIM for one payment. Nobody will ever be shown
        // it. That is real money and it must be reconciled by a human.
        console.error("[webhook] DUPLICATE ESIM PURCHASED — this attempt lost the lease and its eSIM is orphaned; reconcile with the provider", {
          session: session.id,
          orphanedOrder: esim.providerOrderId,
          shownToCustomer: written.record.esim?.providerOrderId ?? null,
        });
        return Response.json({ received: true, superseded: true });
      }

      // TODO: email the QR to the customer. The order page already shows it.
      console.log("[webhook] provisioned", { session: session.id, order: esim.providerOrderId });
    } catch (err) {
      // The customer has paid and has no eSIM. This is the one failure that
      // must page you. Log loudly, alert, and refund if it cannot be fulfilled.
      console.error("[webhook] PROVISIONING FAILED — customer paid, no eSIM issued", {
        session: session.id,
        attempt: claim.record.attempts,
        err,
      });
      const written = await deps.orders.fail(
        session.id,
        claim.claimId,
        err instanceof Error ? err.message : String(err),
      );
      if (written.kind === "superseded") {
        // Stale news: another attempt already settled this order, possibly
        // successfully. Do not ask Stripe to retry something already decided.
        return Response.json({ received: true, superseded: true });
      }
      // Non-2xx so Stripe retries this delivery; a `failed` order does not block it.
      return Response.json({ received: true, error: "provisioning_failed" }, { status: 500 });
    }

    return Response.json({ received: true });
  };
}
