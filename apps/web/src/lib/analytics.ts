// Front-end product analytics. Completely inert (no network, no errors) unless
// VITE_POSTHOG_KEY is set — dev and CI run without a key.
import posthog from "posthog-js";

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";

let enabled = false;

if (KEY) {
  posthog.init(KEY, {
    api_host: HOST,
    capture_pageview: false,
    autocapture: false,
  });
  enabled = true;
}

export function capture(event: string, props?: Record<string, unknown>): void {
  if (!enabled) return;
  posthog.capture(event, props);
}

export function identify(id: string): void {
  if (!enabled) return;
  posthog.identify(id);
}
