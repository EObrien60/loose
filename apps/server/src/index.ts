import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ClientMsg, type ServerMsg, type User } from "@loose/core";
import { createProviders } from "./providers";
import { runAgent } from "./agent";
import { registerHttp } from "./http";
import { workspaceTopic, userTopic } from "./topics";

const PORT = Number(process.env.PORT ?? 8787);
const WS_OPEN = 1;
const HISTORY_LIMIT = 100;
const AUTH_TIMEOUT_MS = Number(process.env.WS_AUTH_TIMEOUT_MS) || 10000;
const MSG_RATE_PER_10S = Number(process.env.WS_MSG_RATE_PER_10S) || 300;

const providers = await createProviders();
const { store, pubsub, presence, huddles, analytics, auth, llm, slack } = providers;

const app = Fastify();
// CORS_ORIGIN=https://app.example.com,https://admin.example.com locks it down in prod; default open for dev.
await app.register(cors, { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()) : true });
await app.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute" });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
registerHttp(app, providers);

// Liveness (process up) and readiness (store reachable) for orchestrators.
app.get("/", async () => ({ ok: true, service: "loose-server", drivers: providers.drivers }));
app.get("/healthz", async () => ({ ok: true }));
app.get("/readyz", async (_req, reply) => {
  try {
    await store.getWorkspace("w_main");
    return { ready: true };
  } catch {
    return reply.code(503).send({ ready: false });
  }
});

app.get("/ws", { websocket: true }, (socket) => {
  let user: { id: string; name: string; workspaceId: string } | null = null;
  const subs = new Map<string, () => void>();
  const myHuddles = new Set<string>();
  let floodWindowStart = Date.now();
  let floodCount = 0;

  // Drop sockets that never authenticate (resource-exhaustion guard).
  const authTimer = setTimeout(() => {
    if (!user && socket.readyState === WS_OPEN) socket.close();
  }, AUTH_TIMEOUT_MS);

  const broadcastHuddle = (channelId: string) =>
    void pubsub.publish(channelId, {
      type: "huddle.state",
      channelId,
      active: huddles.active(channelId),
      participants: huddles.participants(channelId),
    });

  const send = (msg: ServerMsg) => {
    if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(msg));
  };
  const subscribe = (topic: string) => {
    if (!subs.has(topic)) subs.set(topic, pubsub.subscribe(topic, send));
  };
  const broadcastPresence = (workspaceId: string) =>
    void pubsub.publish(workspaceTopic(workspaceId), { type: "presence.changed", online: presence.online(workspaceId) });

  socket.on("message", async (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return send({ type: "error", message: "invalid json" });
    }
    const result = ClientMsg.safeParse(parsed);
    if (!result.success) return send({ type: "error", message: "invalid message" });
    const msg = result.data;

    // Per-connection flood guard (sliding 10s window).
    const now = Date.now();
    if (now - floodWindowStart > 10000) {
      floodWindowStart = now;
      floodCount = 0;
    }
    if (++floodCount > MSG_RATE_PER_10S) return send({ type: "error", message: "rate limited" });

    try {
      await dispatch(msg);
    } catch (err) {
      console.error("ws handler error:", err instanceof Error ? err.message : err);
      send({ type: "error", message: "server error" });
    }
  });

  async function dispatch(msg: ClientMsg) {
    if (msg.type === "auth") {
      const session = await auth.verifySession(msg.sessionToken);
      const u = session ? await store.getUser(session.userId) : null;
      if (!u) return send({ type: "error", message: "auth failed" });
      clearTimeout(authTimer);
      user = { id: u.id, name: u.displayName, workspaceId: u.workspaceId };

      const channels = await store.listChannelsForUser(u.id);
      for (const ch of channels) subscribe(ch.id);
      subscribe(workspaceTopic(u.workspaceId)); // presence + new public channels
      subscribe(userTopic(u.id)); // DMs / private channels created for me

      const me: User = { id: u.id, workspaceId: u.workspaceId, displayName: u.displayName, kind: "human" };
      send({ type: "auth.ok", user: me, channels });

      const transitioned = presence.add(u.workspaceId, u.id);
      send({ type: "presence.changed", online: presence.online(u.workspaceId) });
      if (transitioned) broadcastPresence(u.workspaceId);
      return;
    }

    if (!user) return send({ type: "error", message: "authenticate first" });
    const me = user;

    switch (msg.type) {
      case "channel.subscribe": {
        if (!(await store.canAccess(msg.channelId, me.id))) return send({ type: "error", message: "no access" });
        subscribe(msg.channelId);
        const { messages, reactions } = await store.history(msg.channelId, HISTORY_LIMIT);
        return send({ type: "channel.history", channelId: msg.channelId, messages, reactions });
      }
      case "channel.more": {
        if (!(await store.canAccess(msg.channelId, me.id))) return send({ type: "error", message: "no access" });
        const { messages, reactions, hasMore } = await store.historyBefore(msg.channelId, msg.before, HISTORY_LIMIT);
        return send({ type: "channel.page", channelId: msg.channelId, messages, reactions, hasMore });
      }
      case "message.send": {
        if (!(await store.canAccess(msg.channelId, me.id))) return send({ type: "error", message: "no access" });
        const message = await store.append({
          channelId: msg.channelId,
          userId: me.id,
          userName: me.name,
          body: msg.body,
          threadRootId: msg.threadRootId,
        });
        analytics.capture(me.id, "message_sent", { channelId: msg.channelId, threaded: Boolean(msg.threadRootId) });
        void pubsub.publish(msg.channelId, { type: "message.new", clientId: msg.clientId, message });
        void slack.mirrorOutbound(msg.channelId, me.name, msg.body);
        return;
      }
      case "message.edit": {
        if (!(await store.canAccess(msg.channelId, me.id))) return send({ type: "error", message: "no access" });
        const updated = await store.editMessage(msg.messageId, me.id, msg.body);
        if (!updated || updated.channelId !== msg.channelId) return send({ type: "error", message: "cannot edit" });
        return void pubsub.publish(msg.channelId, { type: "message.updated", message: updated });
      }
      case "message.delete": {
        if (!(await store.canAccess(msg.channelId, me.id))) return send({ type: "error", message: "no access" });
        const updated = await store.deleteMessage(msg.messageId, me.id);
        if (!updated || updated.channelId !== msg.channelId) return send({ type: "error", message: "cannot delete" });
        return void pubsub.publish(msg.channelId, { type: "message.updated", message: updated });
      }
      case "huddle.join": {
        if (!(await store.canAccess(msg.channelId, me.id))) return send({ type: "error", message: "no access" });
        huddles.join(msg.channelId, { userId: me.id, userName: me.name });
        myHuddles.add(msg.channelId);
        return broadcastHuddle(msg.channelId);
      }
      case "huddle.leave": {
        huddles.leave(msg.channelId, me.id);
        myHuddles.delete(msg.channelId);
        return broadcastHuddle(msg.channelId);
      }
      case "agent.invoke": {
        if (!(await store.canAccess(msg.channelId, me.id))) return send({ type: "error", message: "no access" });
        analytics.capture(me.id, "agent_invoked", { channelId: msg.channelId });
        void runAgent({ store, pubsub, llm }, { channelId: msg.channelId, threadRootId: msg.threadRootId, prompt: msg.prompt });
        return;
      }
      case "reaction.add":
      case "reaction.remove": {
        if (!(await store.canAccess(msg.channelId, me.id))) return;
        // Verify the target message actually lives in the channel the caller can access —
        // otherwise a user could react to messages in channels they can't see.
        const target = await store.getMessage(msg.messageId);
        if (!target || target.channelId !== msg.channelId) return;
        const reaction =
          msg.type === "reaction.add"
            ? await store.addReaction(msg.messageId, msg.emoji, me.id)
            : await store.removeReaction(msg.messageId, msg.emoji, me.id);
        return void pubsub.publish(msg.channelId, { type: "reaction.changed", reaction });
      }
      case "typing.start":
        return void pubsub.publish(msg.channelId, {
          type: "typing",
          channelId: msg.channelId,
          userId: me.id,
          userName: me.name,
        });
      case "channel.read": {
        const at = Date.now();
        await store.setRead(msg.channelId, me.id, at);
        return void pubsub.publish(msg.channelId, { type: "read.updated", channelId: msg.channelId, userId: me.id, at });
      }
    }
  }

  socket.on("close", () => {
    clearTimeout(authTimer);
    for (const unsub of subs.values()) unsub();
    subs.clear();
    if (user) {
      for (const channelId of myHuddles) {
        huddles.leave(channelId, user.id);
        broadcastHuddle(channelId);
      }
      if (presence.remove(user.workspaceId, user.id)) broadcastPresence(user.workspaceId);
    }
  });
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`loose-server :${PORT}  ${Object.entries(providers.drivers).map(([k, v]) => `${k}=${v}`).join("  ")}`);

let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig} — draining…`);
    void (async () => {
      await app.close();
      await providers.shutdown();
      process.exit(0);
    })();
  });
}
