import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, ilike, inArray, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  createDb,
  type DbHandle,
  bots,
  channelMembers,
  channels,
  credentials,
  invites,
  memberships,
  messages,
  reactions as reactionsTable,
  sessions as sessionsTable,
  users as usersTable,
  workspaces,
} from "@loose/db";
import { DEFAULT_WORKSPACE, type Block, type Attachment, type Channel, type Message, type Reaction } from "@loose/core";
import type { CredentialRepo, SessionRepo, UserRecord, UserRepo } from "@loose/auth";
import type { AppendInput, Member, Role, StoredUser, Store, Workspace } from "./store";

const SYSTEM_USER = "u_system";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type UserRow = typeof usersTable.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

/** Postgres / PGlite backed store. Same SQL & migrations across both drivers. */
export class PgStore implements Store {
  kind: string;
  private db: DbHandle["db"];
  private handle: DbHandle;

  private constructor(handle: DbHandle) {
    this.handle = handle;
    this.db = handle.db;
    this.kind = handle.driver;
  }

  static async create(url: string): Promise<PgStore> {
    const handle = await createDb(url);
    await handle.migrate();
    const store = new PgStore(handle);
    await store.seed();
    return store;
  }

  private async seed(): Promise<void> {
    const existing = await this.db.select().from(workspaces).where(eq(workspaces.id, DEFAULT_WORKSPACE)).limit(1);
    if (existing.length) return;
    await this.db.insert(workspaces).values({ id: DEFAULT_WORKSPACE, name: "Loose", slug: "loose" });
    await this.db.insert(usersTable).values({
      id: SYSTEM_USER,
      workspaceId: DEFAULT_WORKSPACE,
      displayName: "Loose",
      kind: "system",
    });
    for (const name of ["general", "dev", "ci", "alerts", "product", "random"]) {
      await this.db.insert(channels).values({ id: `c_${name}`, workspaceId: DEFAULT_WORKSPACE, name, kind: "public" });
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  // ── mapping ──────────────────────────────────────────────────
  private toUser(r: UserRow): StoredUser {
    return { id: r.id, workspaceId: r.workspaceId, displayName: r.displayName, email: "", kind: r.kind, avatarUrl: r.avatarUrl };
  }
  private toChannel(r: ChannelRow): Channel {
    return { id: r.id, workspaceId: r.workspaceId, name: r.name, kind: r.kind as Channel["kind"], source: r.source, topic: r.topic };
  }
  private toMessage(r: MessageRow, replyCount = 0): Message {
    return {
      id: r.id,
      channelId: r.channelId,
      userId: r.userId,
      userName: r.userName,
      kind: r.kind as Message["kind"],
      body: r.body,
      blocks: (r.blocks as Block[] | null) ?? null,
      attachments: (r.attachments as Attachment[] | null) ?? null,
      threadRootId: r.threadRootId ?? null,
      replyCount,
      createdAt: r.createdAt.getTime(),
      editedAt: r.editedAt ? r.editedAt.getTime() : null,
      deletedAt: r.deletedAt ? r.deletedAt.getTime() : null,
    };
  }

  // ── auth repos ───────────────────────────────────────────────
  users: UserRepo = {
    findByEmail: async (email) => {
      const r = await this.db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
      return r[0] ? { ...this.toUser(r[0]), email: r[0].email ?? "" } : null;
    },
    findById: async (id) => {
      const r = await this.db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
      return r[0] ? { ...this.toUser(r[0]), email: r[0].email ?? "" } : null;
    },
    create: async ({ workspaceId, displayName, email }) => {
      const id = `u_${nanoid(8)}`;
      await this.db.insert(usersTable).values({ id, workspaceId, displayName, email: email.toLowerCase(), kind: "human" });
      return { id, workspaceId, displayName, email: email.toLowerCase(), kind: "human" };
    },
  };

  creds: CredentialRepo = {
    get: async (userId) => {
      const r = await this.db.select().from(credentials).where(eq(credentials.userId, userId)).limit(1);
      return r[0] ? { userId: r[0].userId, type: r[0].type, secretHash: r[0].secretHash } : null;
    },
    set: async (cred) => {
      await this.db
        .insert(credentials)
        .values(cred)
        .onConflictDoUpdate({ target: credentials.userId, set: { type: cred.type, secretHash: cred.secretHash } });
    },
  };

  sessions: SessionRepo = {
    create: async (s) => {
      await this.db.insert(sessionsTable).values({
        token: s.token,
        userId: s.userId,
        createdAt: new Date(s.createdAt),
        expiresAt: new Date(s.expiresAt),
      });
    },
    find: async (token) => {
      const r = await this.db.select().from(sessionsTable).where(eq(sessionsTable.token, token)).limit(1);
      return r[0] ? { token: r[0].token, userId: r[0].userId, createdAt: r[0].createdAt.getTime(), expiresAt: r[0].expiresAt.getTime() } : null;
    },
    delete: async (token) => void (await this.db.delete(sessionsTable).where(eq(sessionsTable.token, token))),
  };

  // ── users ────────────────────────────────────────────────────
  async systemUser(): Promise<StoredUser> {
    return (await this.getUser(SYSTEM_USER))!;
  }
  async getUser(id: string): Promise<StoredUser | null> {
    const r = await this.db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    return r[0] ? this.toUser(r[0]) : null;
  }
  async listHumans(workspaceId: string): Promise<UserRecord[]> {
    const rows = await this.db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.workspaceId, workspaceId), eq(usersTable.kind, "human")));
    return rows.map((r) => ({ ...this.toUser(r), email: r.email ?? "" }));
  }

  // ── channels ─────────────────────────────────────────────────
  async createChannel(workspaceId: string, name: string, kind: Channel["kind"], creatorId?: string): Promise<Channel> {
    const id = `c_${nanoid(8)}`;
    await this.db.insert(channels).values({ id, workspaceId, name, kind });
    if (creatorId) await this.join(id, creatorId);
    return { id, workspaceId, name, kind, source: "native" };
  }
  async getChannel(id: string): Promise<Channel | null> {
    const r = await this.db.select().from(channels).where(eq(channels.id, id)).limit(1);
    return r[0] ? this.toChannel(r[0]) : null;
  }
  async getChannelByName(workspaceId: string, name: string): Promise<Channel | null> {
    const r = await this.db
      .select()
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)))
      .limit(1);
    return r[0] ? this.toChannel(r[0]) : null;
  }
  async ensureChannel(workspaceId: string, name: string): Promise<Channel> {
    return (await this.getChannelByName(workspaceId, name)) ?? this.createChannel(workspaceId, name, "public");
  }
  async isMember(channelId: string, userId: string): Promise<boolean> {
    const r = await this.db
      .select({ c: channelMembers.channelId })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
      .limit(1);
    return r.length > 0;
  }
  async canAccess(channelId: string, userId: string): Promise<boolean> {
    const ch = await this.getChannel(channelId);
    const user = await this.getUser(userId);
    if (!ch || !user || user.workspaceId !== ch.workspaceId) return false;
    return ch.kind === "public" || (await this.isMember(channelId, userId));
  }
  async join(channelId: string, userId: string): Promise<void> {
    await this.db.insert(channelMembers).values({ channelId, userId }).onConflictDoNothing();
  }
  private async membersOf(channelId: string): Promise<string[]> {
    const rows = await this.db.select({ u: channelMembers.userId }).from(channelMembers).where(eq(channelMembers.channelId, channelId));
    return rows.map((r) => r.u);
  }
  async getOrCreateDm(workspaceId: string, a: string, b: string): Promise<Channel> {
    const aDms = await this.db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
      .where(and(eq(channels.kind, "dm"), eq(channelMembers.userId, a)));
    for (const { id } of aDms) {
      const members = await this.membersOf(id);
      if (members.length === 2 && members.includes(b)) return { ...(await this.getChannel(id))!, members };
    }
    const id = `dm_${nanoid(8)}`;
    await this.db.insert(channels).values({ id, workspaceId, name: "dm", kind: "dm" });
    await this.db.insert(channelMembers).values([{ channelId: id, userId: a }, { channelId: id, userId: b }]);
    return { id, workspaceId, name: "dm", kind: "dm", source: "native", members: [a, b] };
  }
  async listChannelsForUser(userId: string): Promise<Channel[]> {
    const user = await this.getUser(userId);
    if (!user) return [];
    const memberIds = (
      await this.db.select({ c: channelMembers.channelId }).from(channelMembers).where(eq(channelMembers.userId, userId))
    ).map((r) => r.c);
    const rows = await this.db.select().from(channels).where(eq(channels.workspaceId, user.workspaceId));
    const visible = rows.filter((c) => c.kind === "public" || memberIds.includes(c.id));
    const out: Channel[] = [];
    for (const c of visible) {
      const ch = this.toChannel(c);
      out.push(c.kind === "dm" ? { ...ch, members: await this.membersOf(c.id) } : ch);
    }
    return out.sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === "public" ? -1 : 1));
  }

  // ── messages ─────────────────────────────────────────────────
  async append(input: AppendInput): Promise<Message> {
    const id = nanoid();
    const row = {
      id,
      channelId: input.channelId,
      userId: input.userId,
      userName: input.userName,
      kind: input.kind ?? "human",
      body: input.body,
      blocks: input.blocks ?? null,
      attachments: input.attachments ?? null,
      threadRootId: input.threadRootId ?? null,
      ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
    };
    await this.db.insert(messages).values(row);
    const r = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return this.toMessage(r[0]!);
  }
  private async replyCounts(rootIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!rootIds.length) return map;
    const rows = await this.db
      .select({ root: messages.threadRootId, n: sql<number>`count(*)::int` })
      .from(messages)
      .where(inArray(messages.threadRootId, rootIds))
      .groupBy(messages.threadRootId);
    for (const r of rows) if (r.root) map.set(r.root, Number(r.n));
    return map;
  }
  async history(channelId: string, limit: number): Promise<{ messages: Message[]; reactions: Reaction[] }> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    rows.reverse();
    const counts = await this.replyCounts(rows.map((r) => r.id));
    const out = rows.map((r) => this.toMessage(r, counts.get(r.id) ?? 0));
    return { messages: out, reactions: await this.reactionsFor(out.map((m) => m.id)) };
  }
  async historyBefore(channelId: string, before: number, limit: number) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), lt(messages.createdAt, new Date(before))))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const counts = await this.replyCounts(page.map((r) => r.id));
    const out = page.map((r) => this.toMessage(r, counts.get(r.id) ?? 0));
    return { messages: out, reactions: await this.reactionsFor(out.map((m) => m.id)), hasMore };
  }
  async getMessage(id: string): Promise<Message | null> {
    const r = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return r[0] ? this.toMessage(r[0]) : null;
  }
  async editMessage(messageId: string, userId: string, body: string): Promise<Message | null> {
    const cur = await this.db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!cur[0] || cur[0].userId !== userId || cur[0].deletedAt) return null;
    await this.db.update(messages).set({ body, editedAt: new Date() }).where(eq(messages.id, messageId));
    return this.getMessage(messageId);
  }
  async deleteMessage(messageId: string, userId: string): Promise<Message | null> {
    const cur = await this.db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!cur[0] || cur[0].userId !== userId) return null;
    await this.db.update(messages).set({ deletedAt: new Date(), body: "", attachments: null }).where(eq(messages.id, messageId));
    return this.getMessage(messageId);
  }
  async search(userId: string, query: string, limit = 50): Promise<Message[]> {
    const q = query.trim();
    if (!q) return [];
    const rows = await this.db
      .select()
      .from(messages)
      .where(ilike(messages.body, `%${q}%`))
      .orderBy(desc(messages.createdAt))
      .limit(limit * 3);
    const out: Message[] = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      if (await this.canAccess(r.channelId, userId)) out.push(this.toMessage(r));
    }
    return out;
  }

  // ── reactions ────────────────────────────────────────────────
  async addReaction(messageId: string, emoji: string, userId: string): Promise<Reaction> {
    await this.db.insert(reactionsTable).values({ messageId, emoji, userId }).onConflictDoNothing();
    return this.reactionRecord(messageId, emoji);
  }
  async removeReaction(messageId: string, emoji: string, userId: string): Promise<Reaction> {
    await this.db
      .delete(reactionsTable)
      .where(and(eq(reactionsTable.messageId, messageId), eq(reactionsTable.emoji, emoji), eq(reactionsTable.userId, userId)));
    return this.reactionRecord(messageId, emoji);
  }
  private async reactionRecord(messageId: string, emoji: string): Promise<Reaction> {
    const rows = await this.db
      .select({ u: reactionsTable.userId })
      .from(reactionsTable)
      .where(and(eq(reactionsTable.messageId, messageId), eq(reactionsTable.emoji, emoji)));
    return { messageId, emoji, userIds: rows.map((r) => r.u) };
  }
  async reactionsFor(messageIds: string[]): Promise<Reaction[]> {
    if (!messageIds.length) return [];
    const rows = await this.db.select().from(reactionsTable).where(inArray(reactionsTable.messageId, messageIds));
    const byKey = new Map<string, Reaction>();
    for (const r of rows) {
      const key = `${r.messageId}|${r.emoji}`;
      let rec = byKey.get(key);
      if (!rec) byKey.set(key, (rec = { messageId: r.messageId, emoji: r.emoji, userIds: [] }));
      rec.userIds.push(r.userId);
    }
    return [...byKey.values()];
  }

  // ── read state (stored on the membership row; reading implies membership) ──
  async setRead(channelId: string, userId: string, at: number): Promise<void> {
    await this.db
      .insert(channelMembers)
      .values({ channelId, userId, lastReadAt: at })
      .onConflictDoUpdate({ target: [channelMembers.channelId, channelMembers.userId], set: { lastReadAt: at } });
  }
  async getRead(channelId: string, userId: string): Promise<number> {
    const r = await this.db
      .select({ at: channelMembers.lastReadAt })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
      .limit(1);
    return r[0]?.at ?? 0;
  }

  // ── bots ─────────────────────────────────────────────────────
  async createBot(workspaceId: string, name: string): Promise<{ user: UserRecord; token: string }> {
    const id = `bot_${nanoid(8)}`;
    await this.db.insert(usersTable).values({ id, workspaceId, displayName: name, kind: "bot" });
    const token = `lbot_${randomBytes(18).toString("base64url")}`;
    await this.db.insert(bots).values({ id, workspaceId, name, tokenHash: sha256(token) });
    return { user: { id, workspaceId, displayName: name, email: "", kind: "bot" }, token };
  }
  async findBotByToken(token: string): Promise<UserRecord | null> {
    const r = await this.db.select().from(bots).where(eq(bots.tokenHash, sha256(token))).limit(1);
    if (!r[0]) return null;
    return { id: r[0].id, workspaceId: r[0].workspaceId, displayName: r[0].name, email: "", kind: "bot" };
  }

  // ── workspaces / tenancy ──
  private toWorkspace(r: typeof workspaces.$inferSelect): Workspace {
    return { id: r.id, name: r.name, slug: r.slug, plan: r.plan, seatLimit: r.seatLimit, stripeCustomerId: r.stripeCustomerId };
  }
  async updateUserProfile(userId: string, patch: { displayName?: string }): Promise<StoredUser | null> {
    const name = patch.displayName?.trim();
    if (name) await this.db.update(usersTable).set({ displayName: name }).where(eq(usersTable.id, userId));
    return this.getUser(userId);
  }
  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    await this.db.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId));
  }
  async createWorkspace(name: string, slug: string): Promise<Workspace> {
    const id = `w_${nanoid(8)}`;
    const seatLimit = Number(process.env.WORKSPACE_SEAT_LIMIT) || 50;
    await this.db.insert(workspaces).values({ id, name, slug, seatLimit });
    for (const ch of ["general", "random"]) await this.createChannel(id, ch, "public");
    return { id, name, slug, plan: "free", seatLimit };
  }
  async getWorkspace(id: string): Promise<Workspace | null> {
    const r = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    return r[0] ? this.toWorkspace(r[0]) : null;
  }
  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    const r = await this.db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    return r[0] ? this.toWorkspace(r[0]) : null;
  }
  async setPlan(workspaceId: string, plan: string, seatLimit: number): Promise<void> {
    await this.db.update(workspaces).set({ plan, seatLimit }).where(eq(workspaces.id, workspaceId));
  }
  async setStripeCustomer(workspaceId: string, customerId: string): Promise<void> {
    await this.db.update(workspaces).set({ stripeCustomerId: customerId }).where(eq(workspaces.id, workspaceId));
  }
  async addMember(workspaceId: string, userId: string, role: Role): Promise<void> {
    await this.db
      .insert(memberships)
      .values({ workspaceId, userId, role })
      .onConflictDoUpdate({ target: [memberships.workspaceId, memberships.userId], set: { role } });
  }
  async getRole(workspaceId: string, userId: string): Promise<Role | null> {
    const r = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .limit(1);
    return (r[0]?.role as Role) ?? null;
  }
  async listMembers(workspaceId: string): Promise<Member[]> {
    const rows = await this.db
      .select({ userId: memberships.userId, role: memberships.role, displayName: usersTable.displayName, email: usersTable.email })
      .from(memberships)
      .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
      .where(eq(memberships.workspaceId, workspaceId));
    return rows.map((r) => ({ userId: r.userId, role: r.role as Role, displayName: r.displayName, email: r.email ?? "" }));
  }
  async setRole(workspaceId: string, userId: string, role: Role): Promise<void> {
    await this.db
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  }
  async memberCount(workspaceId: string): Promise<number> {
    const r = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.workspaceId, workspaceId));
    return Number(r[0]?.n ?? 0);
  }
  async createInvite(workspaceId: string, role: Role): Promise<string> {
    const code = `inv_${nanoid(10)}`;
    await this.db.insert(invites).values({ code, workspaceId, role });
    return code;
  }
  async getInvite(code: string): Promise<{ workspaceId: string; role: Role } | null> {
    const r = await this.db.select().from(invites).where(eq(invites.code, code)).limit(1);
    return r[0] ? { workspaceId: r[0].workspaceId, role: r[0].role as Role } : null;
  }
}
