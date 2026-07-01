import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { DEFAULT_WORKSPACE, type User } from "@loose/core";
import { type UserRecord } from "@loose/auth";
import { nanoid } from "nanoid";
import { getConnector } from "@loose/connectors";
import type { StoredUser, Role } from "./store";
import type { Providers } from "./providers";
import { workspaceTopic, userTopic } from "./topics";
import { handleMcp } from "./mcp";

const toUser = (u: UserRecord & { avatarUrl?: string | null }): User => ({
  id: u.id,
  workspaceId: u.workspaceId,
  displayName: u.displayName,
  avatarUrl: u.avatarUrl ?? null,
  kind: (u.kind === "human" || u.kind === "bot" || u.kind === "agent" ? u.kind : "human") as User["kind"],
});

export function registerHttp(app: FastifyInstance, p: Providers) {
  const { store, auth, pubsub, storage, analytics, slack, media, billing } = p;
  async function userFromReq(req: FastifyRequest): Promise<StoredUser | null> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return null;
    const session = await auth.verifySession(h.slice(7));
    return session ? store.getUser(session.userId) : null;
  }

  // Resolve a request to a user with a sufficient workspace role, else send 401/403.
  async function requireRole(req: FastifyRequest, reply: FastifyReply, roles: Role[]) {
    const user = await userFromReq(req);
    if (!user) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    const role = await store.getRole(user.workspaceId, user.id);
    if (!role || !roles.includes(role)) {
      reply.code(403).send({ error: "insufficient role" });
      return null;
    }
    return { user, role };
  }

  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "ws";

  app.post(
    "/auth/register",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string>;

      // Resolve target workspace + role: invite → join; workspaceName → create+own; else default.
      let workspaceId: string;
      let role: Role;
      if (b.inviteCode) {
        const inv = await store.getInvite(b.inviteCode);
        if (!inv) return reply.code(400).send({ error: "invalid invite code" });
        workspaceId = inv.workspaceId;
        role = inv.role;
      } else if (b.workspaceName) {
        const ws = await store.createWorkspace(b.workspaceName, `${slugify(b.workspaceName)}-${nanoid(4)}`);
        workspaceId = ws.id;
        role = "owner";
      } else {
        workspaceId = DEFAULT_WORKSPACE;
        role = (await store.memberCount(DEFAULT_WORKSPACE)) === 0 ? "owner" : "member";
      }

      const ws = await store.getWorkspace(workspaceId);
      if (ws && (await store.memberCount(workspaceId)) >= ws.seatLimit) {
        return reply.code(403).send({ error: "workspace is full — seat limit reached" });
      }

      const result = await auth.register({ email: b.email ?? "", password: b.password ?? "", displayName: b.displayName ?? "", workspaceId });
      if (!result.ok) return reply.code(400).send({ error: result.error });
      await store.addMember(workspaceId, result.user.id, role);
      analytics.capture(result.user.id, "user_registered", { workspaceId, role });
      return { user: toUser(result.user), sessionToken: result.session.token, workspaceId, role };
    },
  );

  app.post("/auth/login", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const result = await auth.authenticate(req.body);
    if (!result.ok) return reply.code(401).send({ error: result.error });
    return { user: toUser(result.user), sessionToken: result.session.token };
  });

  app.post("/auth/logout", async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) await auth.revokeSession(h.slice(7));
    return { ok: true };
  });

  app.get("/auth/me", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { user: toUser(user) };
  });

  app.get("/users", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { users: (await store.listHumans(user.workspaceId)).map(toUser) };
  });

  app.post("/channels", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const b = (req.body ?? {}) as Record<string, string>;
    const name = (b.name ?? "").trim().replace(/^#/, "");
    if (!name) return reply.code(400).send({ error: "name required" });
    const kind = b.kind === "private" ? "private" : "public";
    const channel = await store.createChannel(user.workspaceId, name, kind, user.id);
    // Live-announce: public channels to the whole workspace, private to the creator only.
    void pubsub.publish(kind === "public" ? workspaceTopic(user.workspaceId) : userTopic(user.id), { type: "channel.created", channel });
    return { channel };
  });

  app.post("/dm", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const b = (req.body ?? {}) as Record<string, string>;
    const other = await store.getUser(b.userId ?? "");
    if (!other || other.workspaceId !== user.workspaceId) return reply.code(400).send({ error: "unknown user" });
    const channel = await store.getOrCreateDm(user.workspaceId, user.id, other.id);
    // Announce the DM to both participants only.
    for (const uid of channel.members ?? [user.id, other.id]) {
      void pubsub.publish(userTopic(uid), { type: "channel.created", channel });
    }
    return { channel };
  });

  app.get("/search", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const q = String((req.query as Record<string, unknown>)?.q ?? "");
    return { messages: await store.search(user.id, q) };
  });

  app.post("/bots", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const b = (req.body ?? {}) as Record<string, string>;
    const name = (b.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    const { user: bot, token } = await store.createBot(user.workspaceId, name);
    return { bot: toUser(bot), token };
  });

  // Inbound connector webhook. The :token path segment is a per-connector shared
  // secret (unvalidated in the pilot). Maps payload -> card -> system message.
  app.post("/webhooks/:connector/:token", async (req, reply) => {
    const { connector } = req.params as { connector: string; token: string };
    const c = getConnector(connector);
    if (!c) return reply.code(404).send({ error: "unknown connector" });
    const result = c.ingest(req.body);
    if (!result) return { ok: true, ignored: true };
    const channel = await store.ensureChannel(DEFAULT_WORKSPACE, result.channelName);
    const sys = await store.systemUser();
    const message = await store.append({
      channelId: channel.id,
      userId: sys.id,
      userName: connector,
      kind: "system",
      body: result.body,
      blocks: result.blocks,
    });
    await pubsub.publish(channel.id, { type: "message.new", message });
    return { ok: true, channelId: channel.id, messageId: message.id };
  });

  // Upload a file to a channel → stored via Storage → posted as a message with an attachment.
  app.post("/channels/:id/files", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const { id: channelId } = req.params as { id: string };
    if (!(await store.canAccess(channelId, user.id))) return reply.code(403).send({ error: "no access" });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: "file required" });
    const data = await part.toBuffer();
    const cleanName = part.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
    const key = `${nanoid(10)}-${cleanName}`;
    await storage.put(key, data, part.mimetype);
    const attachment = { id: key, name: part.filename, mime: part.mimetype, size: data.length, url: storage.urlFor(key) };
    const message = await store.append({
      channelId,
      userId: user.id,
      userName: user.displayName,
      body: part.filename,
      attachments: [attachment],
    });
    await pubsub.publish(channelId, { type: "message.new", message });
    analytics.capture(user.id, "file_uploaded", { mime: part.mimetype, size: data.length });
    return { message };
  });

  // Serve uploaded files (local-disk dev backend; prod would redirect to a signed URL).
  app.get("/files/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    const file = await storage.get(decodeURIComponent(key));
    if (!file) return reply.code(404).send({ error: "not found" });
    return reply.header("content-type", file.mime).send(file.data);
  });

  // ── Workspace / org admin (Phase 3 multi-tenancy) ──
  app.get("/workspace", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const ws = await store.getWorkspace(user.workspaceId);
    if (!ws) return reply.code(404).send({ error: "workspace not found" });
    return {
      workspace: { id: ws.id, name: ws.name, slug: ws.slug, plan: ws.plan, seatLimit: ws.seatLimit, memberCount: await store.memberCount(ws.id) },
      role: await store.getRole(ws.id, user.id),
    };
  });

  app.get("/workspace/members", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { members: await store.listMembers(user.workspaceId) };
  });

  app.post("/workspace/members/:userId/role", async (req, reply) => {
    const ctx = await requireRole(req, reply, ["owner", "admin"]);
    if (!ctx) return;
    const { userId } = req.params as { userId: string };
    const role = (req.body as { role?: string })?.role;
    if (role !== "owner" && role !== "admin" && role !== "member") return reply.code(400).send({ error: "bad role" });
    if (!(await store.getRole(ctx.user.workspaceId, userId))) return reply.code(404).send({ error: "not a member" });
    await store.setRole(ctx.user.workspaceId, userId, role);
    return { ok: true };
  });

  app.post("/workspace/invites", async (req, reply) => {
    const ctx = await requireRole(req, reply, ["owner", "admin"]);
    if (!ctx) return;
    const r = (req.body as { role?: string })?.role;
    const role: Role = r === "admin" ? "admin" : "member";
    return { code: await store.createInvite(ctx.user.workspaceId, role) };
  });

  // Billing — Stripe Checkout (owner only). Reports not-configured without Stripe env.
  app.post("/workspace/billing/checkout", async (req, reply) => {
    const ctx = await requireRole(req, reply, ["owner"]);
    if (!ctx) return;
    return billing.checkout(ctx.user.workspaceId);
  });

  // Stripe webhook → flip plan/seats. Signature verification gated on STRIPE_WEBHOOK_SECRET (pilot accepts JSON).
  app.post("/stripe/webhook", async (req, reply) => {
    const event = (req.body ?? {}) as { type?: string; data?: { object?: { client_reference_id?: string } } };
    const wsId = event.data?.object?.client_reference_id;
    if (wsId && event.type === "checkout.session.completed") await store.setPlan(wsId, "pro", 200);
    if (wsId && event.type === "customer.subscription.deleted") await store.setPlan(wsId, "free", 50);
    return reply.send({ received: true });
  });

  // SCIM 2.0 user provisioning (token-gated) — SSO/IdP-driven user lifecycle behind the auth seam.
  app.post("/scim/v2/Users", async (req, reply) => {
    const token = process.env.SCIM_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: "unauthorized" });
    const b = (req.body ?? {}) as { userName?: string; displayName?: string; emails?: Array<{ value?: string }>; name?: { formatted?: string } };
    const email = b.userName ?? b.emails?.[0]?.value;
    if (!email) return reply.code(400).send({ error: "userName required" });
    const workspaceId = process.env.SCIM_WORKSPACE_ID ?? DEFAULT_WORKSPACE;
    const user = await store.users.create({ workspaceId, displayName: b.displayName ?? b.name?.formatted ?? email, email });
    await store.addMember(workspaceId, user.id, "member");
    return reply.code(201).send({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id: user.id, userName: email, active: true });
  });

  app.delete("/scim/v2/Users/:id", async (req, reply) => {
    const token = process.env.SCIM_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: "unauthorized" });
    // Deprovision: leave the user record but they can no longer authenticate (no live IdP session). v1 no-op ack.
    return reply.code(204).send();
  });

  // Mint a huddle (LiveKit) token for a channel; reports not-configured if creds are absent.
  app.post("/huddles/:id/token", async (req, reply) => {
    const user = await userFromReq(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const { id: channelId } = req.params as { id: string };
    if (!(await store.canAccess(channelId, user.id))) return reply.code(403).send({ error: "no access" });
    return media.mintToken(`loose-${channelId}`, { id: user.id, name: user.displayName });
  });

  // Slack Events API webhook (inbound bridge). Also handles the url_verification handshake.
  app.post("/slack/events", async (req) => slack.handleEvent(req.body));

  // MCP server (JSON-RPC). Authenticated with a bot token.
  app.post("/mcp", async (req, reply) => {
    const h = req.headers.authorization;
    const bot = h?.startsWith("Bearer ") ? await store.findBotByToken(h.slice(7)) : null;
    if (!bot) return reply.code(401).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "unauthorized" } });
    return handleMcp(store, pubsub, bot, req.body as Parameters<typeof handleMcp>[3]);
  });
}
