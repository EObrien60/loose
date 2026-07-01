/**
 * Product analytics (PostHog, server-side). No-ops unless POSTHOG_KEY is set, so
 * dev and tests run clean; production wires the real key. The web client adds the
 * posthog-js front-end counterpart.
 */
export interface Analytics {
  driver: string;
  capture(distinctId: string, event: string, props?: Record<string, unknown>): void;
  shutdown(): Promise<void>;
}

class NoopAnalytics implements Analytics {
  driver = "noop";
  capture(): void {}
  async shutdown(): Promise<void> {}
}

class PostHogAnalytics implements Analytics {
  driver = "posthog";
  private client: { capture: (a: unknown) => void; shutdown: () => Promise<void> } | null = null;
  private ready: Promise<void>;

  constructor(key: string, host?: string) {
    this.ready = import("posthog-node")
      .then(({ PostHog }) => {
        this.client = new PostHog(key, { host: host ?? "https://us.i.posthog.com" }) as never;
      })
      .catch(() => {
        this.client = null;
      });
  }

  capture(distinctId: string, event: string, props?: Record<string, unknown>): void {
    void this.ready.then(() => this.client?.capture({ distinctId, event, properties: props }));
  }

  async shutdown(): Promise<void> {
    await this.ready;
    await this.client?.shutdown();
  }
}

export function createAnalytics(): Analytics {
  const driver = process.env.ANALYTICS_DRIVER ?? (process.env.POSTHOG_KEY ? "posthog" : "noop");
  if (driver === "posthog") {
    const key = process.env.POSTHOG_KEY;
    if (!key) throw new Error("ANALYTICS_DRIVER=posthog requires POSTHOG_KEY");
    return new PostHogAnalytics(key, process.env.POSTHOG_HOST);
  }
  return new NoopAnalytics();
}
