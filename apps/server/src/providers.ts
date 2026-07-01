import { LocalAuthProvider } from "@loose/auth";
import { createStore, type Store } from "./store";
import { createPubSub, type PubSub } from "./pubsub";
import { createStorage, type Storage } from "./storage";
import { createAnalytics, type Analytics } from "./analytics";
import { createLlm, type LlmProvider } from "./llm";
import { createMedia, type MediaProvider } from "./media";
import { createBilling, type BillingProvider } from "./billing";
import { Presence } from "./presence";
import { Huddles } from "./huddles";
import { SlackBridge } from "./slack";

/**
 * Every external surface is a swappable port. This bundle is the single composition root:
 * it builds each provider from env (each with a safe default that needs no credentials), so
 * the app has no hard dependency on any specific vendor — swap one by adding an adapter that
 * implements the port and selecting it via its *_DRIVER env var.
 */
export interface Providers {
  store: Store;
  pubsub: PubSub;
  storage: Storage;
  analytics: Analytics;
  auth: LocalAuthProvider;
  llm: LlmProvider;
  media: MediaProvider;
  billing: BillingProvider;
  presence: Presence;
  huddles: Huddles;
  slack: SlackBridge;
  drivers: Record<string, string>;
  shutdown(): Promise<void>;
}

function createAuth(store: Store): LocalAuthProvider {
  const driver = process.env.AUTH_DRIVER ?? "local";
  // Additional providers (OIDC/SAML/…) implement AuthProvider and slot in here.
  if (driver !== "local") throw new Error(`unknown AUTH_DRIVER: ${driver} (only "local" bundled)`);
  return new LocalAuthProvider(store.users, store.creds, store.sessions);
}

export async function createProviders(): Promise<Providers> {
  const store = await createStore();
  const pubsub = await createPubSub();
  const storage = createStorage();
  const analytics = createAnalytics();
  const llm = createLlm();
  const media = createMedia();
  const billing = createBilling();
  const auth = createAuth(store);

  const drivers = {
    store: store.kind,
    pubsub: pubsub.kind,
    storage: storage.driver,
    analytics: analytics.driver,
    auth: "local",
    llm: llm.driver,
    media: media.driver,
    billing: billing.driver,
  };

  return {
    store,
    pubsub,
    storage,
    analytics,
    auth,
    llm,
    media,
    billing,
    presence: new Presence(),
    huddles: new Huddles(),
    slack: new SlackBridge(store, pubsub),
    drivers,
    async shutdown() {
      await analytics.shutdown().catch(() => {});
      await pubsub.close?.().catch(() => {});
      await store.close?.().catch(() => {});
    },
  };
}
