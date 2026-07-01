import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@loose/core";
import type { Store } from "./store";
import type { PubSub } from "./pubsub";

const tsToMs = (ts: string): number => Math.floor(parseFloat(ts) * 1000) || Date.now();
const channelName = (slackChannel: string, name?: string) => `slack-${name ?? slackChannel}`;

/**
 * Slack bridge. Two mechanisms (see BUILD_PLAN §10):
 *  - importSlackExport: one-time history backfill from a Slack workspace export
 *    (JSON on disk) — sidesteps the 2025 conversations.history rate limits.
 *  - SlackBridge: live two-way bridge. Inbound via the Events API (Slack pushes
 *    events; no polling). Outbound via chat.postMessage (gated on SLACK_BOT_TOKEN).
 */
export class SlackBridge {
  private nativeToSlack = new Map<string, string>(); // native channelId -> Slack channel id

  constructor(
    private store: Store,
    private pubsub: PubSub,
  ) {}

  /** Handle a Slack Events API delivery. Returns the url_verification challenge or an ack. */
  async handleEvent(body: unknown): Promise<{ challenge?: string; ok?: boolean }> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.type === "url_verification") return { challenge: String(b.challenge ?? "") };

    if (b.type === "event_callback") {
      const ev = (b.event ?? {}) as Record<string, unknown>;
      // ignore bot echoes and edits/joins/etc. (no subtype = a plain human message)
      if (ev.type === "message" && !ev.bot_id && !ev.subtype && typeof ev.channel === "string") {
        const channel = await this.store.ensureChannel(DEFAULT_WORKSPACE, channelName(ev.channel));
        this.nativeToSlack.set(channel.id, ev.channel);
        const message = await this.store.append({
          channelId: channel.id,
          userId: `slack_${ev.user ?? "unknown"}`,
          userName: typeof ev.user_name === "string" ? ev.user_name : String(ev.user ?? "slack"),
          body: typeof ev.text === "string" ? ev.text : "",
          createdAt: typeof ev.ts === "string" ? tsToMs(ev.ts) : undefined,
        });
        await this.pubsub.publish(channel.id, { type: "message.new", message });
      }
    }
    return { ok: true };
  }

  /** Mirror a native message back to Slack. No-op unless a token + mapping exist. */
  async mirrorOutbound(channelId: string, userName: string, body: string): Promise<void> {
    const token = process.env.SLACK_BOT_TOKEN;
    const slackChannel = this.nativeToSlack.get(channelId);
    if (!token || !slackChannel) return;
    try {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: slackChannel, text: `*${userName}*: ${body}` }),
      });
    } catch {
      /* best-effort mirror */
    }
  }

  /** Test/ops hook: register a native↔Slack channel mapping (normally set on first inbound event). */
  link(nativeChannelId: string, slackChannelId: string): void {
    this.nativeToSlack.set(nativeChannelId, slackChannelId);
  }
}

/**
 * Import a Slack workspace export directory: `users.json`, `channels.json`, and a
 * folder of daily JSON files per channel. Messages land in `slack-<name>` channels.
 */
export async function importSlackExport(store: Store, dir: string): Promise<{ channels: number; messages: number }> {
  const users = new Map<string, string>();
  try {
    const raw = JSON.parse(await readFile(join(dir, "users.json"), "utf8")) as Array<Record<string, unknown>>;
    for (const u of raw) {
      const profile = (u.profile ?? {}) as Record<string, unknown>;
      const name = (profile.real_name as string) || (u.name as string) || (u.id as string);
      if (typeof u.id === "string") users.set(u.id, name);
    }
  } catch {
    /* users.json optional */
  }

  const channels = JSON.parse(await readFile(join(dir, "channels.json"), "utf8")) as Array<Record<string, unknown>>;
  let messageCount = 0;

  for (const ch of channels) {
    const slackName = String(ch.name ?? ch.id ?? "channel");
    const channel = await store.ensureChannel(DEFAULT_WORKSPACE, channelName(String(ch.id ?? slackName), slackName));
    let files: string[] = [];
    try {
      files = (await readdir(join(dir, slackName))).filter((f) => f.endsWith(".json")).sort();
    } catch {
      continue; // no message folder for this channel
    }
    for (const file of files) {
      const day = JSON.parse(await readFile(join(dir, slackName, file), "utf8")) as Array<Record<string, unknown>>;
      for (const m of day) {
        if (m.type !== "message" || m.subtype || m.bot_id || typeof m.text !== "string") continue;
        const uid = typeof m.user === "string" ? m.user : "unknown";
        await store.append({
          channelId: channel.id,
          userId: `slack_${uid}`,
          userName: users.get(uid) ?? uid,
          body: m.text,
          createdAt: typeof m.ts === "string" ? tsToMs(m.ts) : undefined,
        });
        messageCount++;
      }
    }
  }
  return { channels: channels.length, messages: messageCount };
}
