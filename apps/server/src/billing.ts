/**
 * Billing port. Swap with BILLING_DRIVER (default: `stripe` if STRIPE_SECRET_KEY + STRIPE_PRICE_ID
 * are set, else `none`). The webhook → plan/seat mapping lives in http.ts (provider-agnostic).
 * A new provider (Paddle, Lemon Squeezy, …) = a class implementing BillingProvider.
 */
export interface CheckoutResult {
  configured: boolean;
  url?: string;
}

export interface BillingProvider {
  driver: string;
  /** Start a checkout for upgrading a workspace; client_reference_id carries the workspaceId. */
  checkout(workspaceId: string): Promise<CheckoutResult>;
}

class NoneBilling implements BillingProvider {
  driver = "none";
  async checkout(): Promise<CheckoutResult> {
    return { configured: false };
  }
}

class StripeBilling implements BillingProvider {
  driver = "stripe";
  constructor(
    private secretKey: string,
    private priceId: string,
    private appUrl: string,
  ) {}
  async checkout(workspaceId: string): Promise<CheckoutResult> {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(this.secretKey);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: this.priceId, quantity: 1 }],
      client_reference_id: workspaceId,
      success_url: this.appUrl,
      cancel_url: this.appUrl,
    });
    return { configured: true, url: session.url ?? undefined };
  }
}

export function createBilling(): BillingProvider {
  const driver = process.env.BILLING_DRIVER ?? (process.env.STRIPE_SECRET_KEY ? "stripe" : "none");
  if (driver === "stripe") {
    const key = process.env.STRIPE_SECRET_KEY;
    const price = process.env.STRIPE_PRICE_ID;
    if (!key || !price) throw new Error("BILLING_DRIVER=stripe requires STRIPE_SECRET_KEY and STRIPE_PRICE_ID");
    return new StripeBilling(key, price, process.env.APP_URL ?? "http://localhost:5173");
  }
  return new NoneBilling();
}
