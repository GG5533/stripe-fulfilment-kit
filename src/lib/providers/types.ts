/**
 * Provider adapter interface.
 *
 * This interface is ours, not any vendor's. It exists so the storefront never
 * imports a provider SDK directly and switching wholesalers — or running two at
 * once to arbitrage per-destination pricing — is a config change, not a rewrite.
 *
 * The concrete adapters in this folder are STUBS. Their request and response
 * shapes are NOT filled in, because inventing them would be worse than leaving
 * them empty: you would build against a fiction and find out at integration.
 * Fill each one from the provider's own docs once you have credentials.
 */

export interface ProviderPlan {
  /** Provider's own identifier for the plan. Opaque to us. */
  providerPlanId: string;
  /** ISO 3166-1 alpha-2 codes this plan covers. */
  countries: string[];
  dataGb: number;
  validityDays: number;
  /** Cost to us, in USD cents, all-in per activation. */
  wholesaleCents: number;
  /** True if the plan can be topped up rather than re-purchased. */
  topUpSupported: boolean;
}

export interface OrderRequest {
  providerPlanId: string;
  /** Our order id, passed through for reconciliation. */
  referenceId: string;
  /** Where to send the QR. The provider may or may not email it itself. */
  customerEmail: string;
}

export interface OrderResult {
  /** Provider's order/item identifier, needed for status and top-ups. */
  providerOrderId: string;
  /** LPA activation string, e.g. "LPA:1$rsp.example.com$MATCHINGID". */
  activationCode: string;
  /** QR payload — usually the activation code rendered client-side. */
  qrPayload: string;
  /** Manual entry fallback, for phones that will not scan. */
  smdpAddress?: string;
  matchingId?: string;
  /** Provider's own install instructions URL, if it gives one. */
  instructionsUrl?: string;
}

export interface UsageResult {
  totalGb: number;
  remainingGb: number;
  expiresAt: string | null;
  status: "not-activated" | "active" | "expired" | "depleted" | "unknown";
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface FulfilmentProvider {
  readonly name: string;

  /** Full sellable catalogue. Cache it; do not call this per page view. */
  listPlans(): Promise<ProviderPlan[]>;

  /**
   * Buy and provision one eSIM. MUST be idempotent on `referenceId` — Stripe
   * will deliver the same webhook more than once and you do not want to buy
   * two items for one payment.
   */
  createOrder(req: OrderRequest): Promise<OrderResult>;

  /** Data remaining. Powers the customer's status page. */
  getUsage(providerOrderId: string): Promise<UsageResult>;

  /** Current prepaid balance in USD cents, if the provider exposes it. */
  getBalanceCents?(): Promise<number>;
}
