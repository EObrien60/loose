import type { Block } from "@loose/core";

/** What a connector produces from an inbound webhook payload. */
export interface IngestResult {
  channelName: string; // target channel (created if missing)
  body: string; // plain-text fallback / search text
  blocks?: Block[]; // rich actionable card
}

/**
 * A connector is a privileged integration. v1 covers inbound (webhook -> card).
 * `egress` is reserved for bidirectional connectors (e.g. the Slack bridge mirroring
 * native messages back out) and is unused for now.
 */
export interface Connector {
  type: string;
  ingest(payload: unknown): IngestResult | null;
  egress?(message: { channelId: string; body: string }): Promise<void>;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const get = (o: unknown, k: string): unknown =>
  typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined;

// ── GitHub ───────────────────────────────────────────────────────
const github: Connector = {
  type: "github",
  ingest(payload) {
    const pr = get(payload, "pull_request");
    if (pr) {
      const action = str(get(payload, "action"), "updated");
      const title = str(get(pr, "title"), "(no title)");
      const url = str(get(pr, "html_url"));
      const num = get(pr, "number");
      return {
        channelName: "dev",
        body: `PR #${num} ${action}: ${title}`,
        blocks: [
          { type: "section", text: `*PR #${num} ${action}* — ${title}` },
          { type: "context", text: str(get(get(payload, "sender"), "login"), "github") },
          ...(url ? [{ type: "actions" as const, buttons: [{ text: "View PR", actionId: "open", url, style: "primary" as const }] }] : []),
        ],
      };
    }
    const commits = get(payload, "commits");
    if (Array.isArray(commits)) {
      const ref = str(get(payload, "ref")).replace("refs/heads/", "");
      return {
        channelName: "dev",
        body: `${commits.length} new commit(s) pushed to ${ref}`,
        blocks: [{ type: "section", text: `*${commits.length} commit(s)* pushed to \`${ref}\`` }],
      };
    }
    return null;
  },
};

// ── CI ───────────────────────────────────────────────────────────
const ci: Connector = {
  type: "ci",
  ingest(payload) {
    const status = str(get(payload, "status"), "unknown");
    const ok = /success|passed|green/i.test(status);
    const name = str(get(payload, "pipeline"), str(get(payload, "name"), "build"));
    const url = str(get(payload, "url"));
    return {
      channelName: "ci",
      body: `${name}: ${status}`,
      blocks: [
        { type: "section", text: `${ok ? "✅" : "❌"} *${name}* — ${status}` },
        ...(url
          ? [{ type: "actions" as const, buttons: [{ text: ok ? "View run" : "Re-run", actionId: ok ? "open" : "rerun", url, style: ok ? ("default" as const) : ("danger" as const) }] }]
          : []),
      ],
    };
  },
};

// ── Sentry ───────────────────────────────────────────────────────
const sentry: Connector = {
  type: "sentry",
  ingest(payload) {
    const data = get(payload, "data");
    const issue = get(data, "issue") ?? get(payload, "issue");
    const title = str(get(issue, "title"), "New error");
    const url = str(get(issue, "web_url"), str(get(issue, "url")));
    const culprit = str(get(issue, "culprit"));
    return {
      channelName: "alerts",
      body: `Sentry: ${title}`,
      blocks: [
        { type: "section", text: `🔥 *${title}*` },
        ...(culprit ? [{ type: "context" as const, text: culprit }] : []),
        ...(url ? [{ type: "actions" as const, buttons: [{ text: "Open in Sentry", actionId: "open", url, style: "danger" as const }] }] : []),
      ],
    };
  },
};

// ── PostHog ──────────────────────────────────────────────────────
const posthog: Connector = {
  type: "posthog",
  ingest(payload) {
    const name = str(get(payload, "name"), str(get(payload, "event"), "insight"));
    const value = get(payload, "value");
    return {
      channelName: "product",
      body: `PostHog: ${name}${value !== undefined ? ` = ${String(value)}` : ""}`,
      blocks: [
        { type: "section", text: `📊 *${name}*${value !== undefined ? ` — ${String(value)}` : ""}` },
        { type: "context", text: "posthog" },
      ],
    };
  },
};

// ── Solar (placeholder stub — wired into the framework, no-ops until defined) ──
const solar: Connector = {
  type: "solar",
  ingest() {
    return null; // TODO: define the Solar event contract, then map to cards here.
  },
};

const REGISTRY: Record<string, Connector> = { github, ci, sentry, posthog, solar };

export function getConnector(type: string): Connector | null {
  return REGISTRY[type] ?? null;
}

export const connectorTypes = Object.keys(REGISTRY);
