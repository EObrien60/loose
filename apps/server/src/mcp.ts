import type { UserRecord } from "@loose/auth";
import type { Store } from "./store";
import type { PubSub } from "./pubsub";

/**
 * Minimal MCP server over JSON-RPC: exposes the workspace as tools so any external
 * agent (e.g. Claude) can read and post natively. Methods follow the MCP spec
 * (initialize / tools/list / tools/call); authenticated with a bot token.
 */

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: "list_channels",
    description: "List channels the bot can access in the workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_channel",
    description: "Read recent messages from a channel.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" }, limit: { type: "number" } },
      required: ["channelId"],
    },
  },
  {
    name: "search_messages",
    description: "Full-text search messages the bot can access.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "post_message",
    description: "Post a message to a channel as this bot.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string" }, body: { type: "string" } },
      required: ["channelId", "body"],
    },
  },
];

const text = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

export async function handleMcp(store: Store, pubsub: PubSub, bot: UserRecord, rpc: Rpc) {
  const id = rpc.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (rpc.method) {
    case "initialize":
      return ok({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "loose", version: "0.1.0" },
      });

    case "tools/list":
      return ok({ tools: TOOLS });

    case "tools/call": {
      const name = String(rpc.params?.name ?? "");
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;

      if (name === "list_channels") {
        const channels = await store.listChannelsForUser(bot.id);
        return ok(text(channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind }))));
      }
      if (name === "read_channel") {
        const channelId = String(args.channelId ?? "");
        if (!(await store.canAccess(channelId, bot.id))) return fail(-32602, "no access to channel");
        const limit = typeof args.limit === "number" ? args.limit : 30;
        const { messages } = await store.history(channelId, limit);
        return ok(text(messages.map((m) => ({ id: m.id, from: m.userName, body: m.body, at: m.createdAt }))));
      }
      if (name === "search_messages") {
        const query = String(args.query ?? "");
        const matches = await store.search(bot.id, query);
        return ok(text(matches.map((m) => ({ id: m.id, channelId: m.channelId, from: m.userName, body: m.body }))));
      }
      if (name === "post_message") {
        const channelId = String(args.channelId ?? "");
        const body = String(args.body ?? "");
        if (!(await store.canAccess(channelId, bot.id))) return fail(-32602, "no access to channel");
        if (!body) return fail(-32602, "body required");
        const message = await store.append({ channelId, userId: bot.id, userName: bot.displayName, body, kind: "agent" });
        await pubsub.publish(channelId, { type: "message.new", message });
        return ok(text({ ok: true, messageId: message.id }));
      }
      return fail(-32602, `unknown tool: ${name}`);
    }

    default:
      return fail(-32601, `method not found: ${rpc.method}`);
  }
}
