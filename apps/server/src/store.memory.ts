import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { DEFAULT_WORKSPACE, type Channel, type Message, type Reaction } from "@loose/core";
import type { CredentialRecord, CredentialRepo, SessionRecord, SessionRepo, UserRecord, UserRepo } from "@loose/auth";
import type { AppendInput, Member, Role, StoredUser, Store, Workspace } from "./store";

const SYSTEM_USER = "u_system";

/** In-memory implementation of the full Store contract. Ephemeral; great for dev. */
export class MemoryStore implements Store {
  kind = "memory";

  private usersById = new Map<string, StoredUser>();
  private emailToId = new Map<string, string>();
  private credsByUser = new Map<string, CredentialRecord>();
  private sessionsByToken = new Map<string, SessionRecord>();

  private channelsById = new Map<string, Channel>();
  private membersByChannel = new Map<string, Set<string>>();
  private dmKeyToChannel = new Map<string, string>();

  private messagesByChannel = new Map<string, Message[]>();
  private messageById = new Map<string, Message>();
  private reactions = new Map<string, Map<string, Set<string>>>();
  private readByKey = new Map<string, number>();

  private botTokenToUser = new Map<string, string>();

  private workspacesById = new Map<string, Workspace>();
  private slugToWorkspace = new Map<string, string>();
  private memberships = new Map<string, Role>(); // `${workspaceId}:${userId}` -> role
  private invitesByCode = new Map<string, { workspaceId: string; role: Role }>();

  constructor() {
    this.usersById.set(SYSTEM_USER, {
      id: SYSTEM_USER,
      workspaceId: DEFAULT_WORKSPACE,
      displayName: "Loose",
      email: "system@loose.local",
      kind: "system",
    });
    this.workspacesById.set(DEFAULT_WORKSPACE, { id: DEFAULT_WORKSPACE, name: "Loose", slug: "loose", plan: "free", seatLimit: 50 });
    this.slugToWorkspace.set("loose", DEFAULT_WORKSPACE);
    for (const name of ["general", "dev", "ci", "alerts", "product", "random"]) this.seedChannel(DEFAULT_WORKSPACE, name);
  }

  private seedChannel(workspaceId: string, name: string): void {
    const id = `c_${nanoid(8)}_${name}`;
    this.channelsById.set(id, { id, workspaceId, name, kind: "public", source: "native" });
    this.membersByChannel.set(id, new Set());
    this.messagesByChannel.set(id, []);
  }

  users: UserRepo = {
    findByEmail: async (email) => {
      const id = this.emailToId.get(email.toLowerCase());
      return id ? (this.usersById.get(id) ?? null) : null;
    },
    findById: async (id) => this.usersById.get(id) ?? null,
    create: async ({ workspaceId, displayName, email }) => {
      const user: UserRecord = { id: `u_${nanoid(8)}`, workspaceId, displayName, email, kind: "human" };
      this.usersById.set(user.id, user);
      this.emailToId.set(email.toLowerCase(), user.id);
      return user;
    },
  };

  creds: CredentialRepo = {
    get: async (userId) => this.credsByUser.get(userId) ?? null,
    set: async (cred) => void this.credsByUser.set(cred.userId, cred),
  };

  sessions: SessionRepo = {
    create: async (s) => void this.sessionsByToken.set(s.token, s),
    find: async (token) => this.sessionsByToken.get(token) ?? null,
    delete: async (token) => void this.sessionsByToken.delete(token),
  };

  async systemUser(): Promise<StoredUser> {
    return this.usersById.get(SYSTEM_USER)!;
  }
  async getUser(id: string): Promise<StoredUser | null> {
    return this.usersById.get(id) ?? null;
  }
  async listHumans(workspaceId: string): Promise<UserRecord[]> {
    return [...this.usersById.values()].filter((u) => u.workspaceId === workspaceId && u.kind === "human");
  }

  async createChannel(workspaceId: string, name: string, kind: Channel["kind"], creatorId?: string): Promise<Channel> {
    const id = `c_${nanoid(8)}`;
    const channel: Channel = { id, workspaceId, name, kind, source: "native" };
    this.channelsById.set(id, channel);
    this.membersByChannel.set(id, new Set(creatorId ? [creatorId] : []));
    this.messagesByChannel.set(id, []);
    return channel;
  }
  async getChannel(id: string): Promise<Channel | null> {
    return this.channelsById.get(id) ?? null;
  }
  async getChannelByName(workspaceId: string, name: string): Promise<Channel | null> {
    for (const ch of this.channelsById.values()) if (ch.workspaceId === workspaceId && ch.name === name) return ch;
    return null;
  }
  async ensureChannel(workspaceId: string, name: string): Promise<Channel> {
    return (await this.getChannelByName(workspaceId, name)) ?? this.createChannel(workspaceId, name, "public");
  }
  async isMember(channelId: string, userId: string): Promise<boolean> {
    return this.membersByChannel.get(channelId)?.has(userId) ?? false;
  }
  async canAccess(channelId: string, userId: string): Promise<boolean> {
    const ch = this.channelsById.get(channelId);
    const user = this.usersById.get(userId);
    if (!ch || !user || user.workspaceId !== ch.workspaceId) return false;
    return ch.kind === "public" || (await this.isMember(channelId, userId));
  }
  async join(channelId: string, userId: string): Promise<void> {
    this.membersByChannel.get(channelId)?.add(userId);
  }
  async getOrCreateDm(workspaceId: string, a: string, b: string): Promise<Channel> {
    const key = [a, b].sort().join("|");
    const existing = this.dmKeyToChannel.get(key);
    if (existing) return this.withMembers(this.channelsById.get(existing)!);
    const id = `dm_${nanoid(8)}`;
    const channel: Channel = { id, workspaceId, name: "dm", kind: "dm", source: "native" };
    this.channelsById.set(id, channel);
    this.membersByChannel.set(id, new Set([a, b]));
    this.messagesByChannel.set(id, []);
    this.dmKeyToChannel.set(key, id);
    return this.withMembers(channel);
  }
  private withMembers(ch: Channel): Channel {
    return ch.kind === "dm" ? { ...ch, members: [...(this.membersByChannel.get(ch.id) ?? [])] } : ch;
  }
  async listChannelsForUser(userId: string): Promise<Channel[]> {
    const user = this.usersById.get(userId);
    if (!user) return [];
    return [...this.channelsById.values()]
      .filter((ch) => ch.workspaceId === user.workspaceId && (ch.kind === "public" || this.membersByChannel.get(ch.id)?.has(userId)))
      .map((ch) => this.withMembers(ch))
      .sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === "public" ? -1 : 1));
  }

  async append(input: AppendInput): Promise<Message> {
    const message: Message = {
      id: nanoid(),
      channelId: input.channelId,
      userId: input.userId,
      userName: input.userName,
      kind: input.kind ?? "human",
      body: input.body,
      blocks: input.blocks ?? null,
      attachments: input.attachments ?? null,
      threadRootId: input.threadRootId ?? null,
      replyCount: 0,
      createdAt: input.createdAt ?? Date.now(),
      editedAt: null,
      deletedAt: null,
    };
    const list = this.messagesByChannel.get(input.channelId) ?? [];
    list.push(message);
    this.messagesByChannel.set(input.channelId, list);
    this.messageById.set(message.id, message);
    if (message.threadRootId) {
      const root = this.messageById.get(message.threadRootId);
      if (root) root.replyCount = (root.replyCount ?? 0) + 1;
    }
    return message;
  }
  async history(channelId: string, limit: number): Promise<{ messages: Message[]; reactions: Reaction[] }> {
    const messages = (this.messagesByChannel.get(channelId) ?? []).slice(-limit);
    return { messages, reactions: await this.reactionsFor(messages.map((m) => m.id)) };
  }
  async historyBefore(channelId: string, before: number, limit: number) {
    const all = this.messagesByChannel.get(channelId) ?? [];
    const older = all.filter((m) => m.createdAt < before);
    const messages = older.slice(-limit);
    return { messages, reactions: await this.reactionsFor(messages.map((m) => m.id)), hasMore: older.length > messages.length };
  }
  async getMessage(id: string): Promise<Message | null> {
    return this.messageById.get(id) ?? null;
  }
  async editMessage(messageId: string, userId: string, body: string): Promise<Message | null> {
    const m = this.messageById.get(messageId);
    if (!m || m.userId !== userId || m.deletedAt) return null;
    m.body = body;
    m.editedAt = Date.now();
    return m;
  }
  async deleteMessage(messageId: string, userId: string): Promise<Message | null> {
    const m = this.messageById.get(messageId);
    if (!m || m.userId !== userId) return null;
    m.deletedAt = Date.now();
    m.body = "";
    m.attachments = null;
    return m;
  }
  async search(userId: string, query: string, limit = 50): Promise<Message[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Message[] = [];
    for (const m of this.messageById.values()) {
      if (m.body.toLowerCase().includes(q) && (await this.canAccess(m.channelId, userId))) out.push(m);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  private reactionRecord(messageId: string, emoji: string): Reaction {
    return { messageId, emoji, userIds: [...(this.reactions.get(messageId)?.get(emoji) ?? [])] };
  }
  async addReaction(messageId: string, emoji: string, userId: string): Promise<Reaction> {
    let byEmoji = this.reactions.get(messageId);
    if (!byEmoji) this.reactions.set(messageId, (byEmoji = new Map()));
    let set = byEmoji.get(emoji);
    if (!set) byEmoji.set(emoji, (set = new Set()));
    set.add(userId);
    return this.reactionRecord(messageId, emoji);
  }
  async removeReaction(messageId: string, emoji: string, userId: string): Promise<Reaction> {
    this.reactions.get(messageId)?.get(emoji)?.delete(userId);
    return this.reactionRecord(messageId, emoji);
  }
  async reactionsFor(messageIds: string[]): Promise<Reaction[]> {
    const out: Reaction[] = [];
    for (const id of messageIds) {
      const byEmoji = this.reactions.get(id);
      if (!byEmoji) continue;
      for (const [emoji, set] of byEmoji) if (set.size > 0) out.push({ messageId: id, emoji, userIds: [...set] });
    }
    return out;
  }

  async setRead(channelId: string, userId: string, at: number): Promise<void> {
    this.readByKey.set(`${channelId}:${userId}`, at);
  }
  async getRead(channelId: string, userId: string): Promise<number> {
    return this.readByKey.get(`${channelId}:${userId}`) ?? 0;
  }

  async createBot(workspaceId: string, name: string): Promise<{ user: UserRecord; token: string }> {
    const user: UserRecord = { id: `bot_${nanoid(8)}`, workspaceId, displayName: name, email: "", kind: "bot" };
    this.usersById.set(user.id, user);
    const token = `lbot_${randomBytes(18).toString("base64url")}`;
    this.botTokenToUser.set(token, user.id);
    return { user, token };
  }
  async findBotByToken(token: string): Promise<UserRecord | null> {
    const id = this.botTokenToUser.get(token);
    return id ? (this.usersById.get(id) ?? null) : null;
  }

  // ── workspaces / tenancy ──
  async createWorkspace(name: string, slug: string): Promise<Workspace> {
    const id = `w_${nanoid(8)}`;
    const ws: Workspace = { id, name, slug, plan: "free", seatLimit: Number(process.env.WORKSPACE_SEAT_LIMIT) || 50 };
    this.workspacesById.set(id, ws);
    this.slugToWorkspace.set(slug, id);
    for (const ch of ["general", "random"]) this.seedChannel(id, ch);
    return ws;
  }
  async updateUserProfile(userId: string, patch: { displayName?: string }): Promise<StoredUser | null> {
    const u = this.usersById.get(userId);
    if (!u) return null;
    const name = patch.displayName?.trim();
    if (name) u.displayName = name;
    return u as StoredUser;
  }
  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const ws = this.workspacesById.get(workspaceId);
    if (ws) ws.name = name;
  }
  async getWorkspace(id: string): Promise<Workspace | null> {
    return this.workspacesById.get(id) ?? null;
  }
  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    const id = this.slugToWorkspace.get(slug);
    return id ? (this.workspacesById.get(id) ?? null) : null;
  }
  async setPlan(workspaceId: string, plan: string, seatLimit: number): Promise<void> {
    const ws = this.workspacesById.get(workspaceId);
    if (ws) Object.assign(ws, { plan, seatLimit });
  }
  async setStripeCustomer(workspaceId: string, customerId: string): Promise<void> {
    const ws = this.workspacesById.get(workspaceId);
    if (ws) ws.stripeCustomerId = customerId;
  }
  async addMember(workspaceId: string, userId: string, role: Role): Promise<void> {
    this.memberships.set(`${workspaceId}:${userId}`, role);
  }
  async getRole(workspaceId: string, userId: string): Promise<Role | null> {
    return this.memberships.get(`${workspaceId}:${userId}`) ?? null;
  }
  async listMembers(workspaceId: string): Promise<Member[]> {
    const out: Member[] = [];
    for (const [key, role] of this.memberships) {
      const [ws, uid] = key.split(":");
      if (ws !== workspaceId) continue;
      const u = this.usersById.get(uid);
      if (u) out.push({ userId: uid, role, displayName: u.displayName, email: u.email });
    }
    return out;
  }
  async setRole(workspaceId: string, userId: string, role: Role): Promise<void> {
    if (this.memberships.has(`${workspaceId}:${userId}`)) this.memberships.set(`${workspaceId}:${userId}`, role);
  }
  async memberCount(workspaceId: string): Promise<number> {
    let n = 0;
    for (const key of this.memberships.keys()) if (key.startsWith(`${workspaceId}:`)) n++;
    return n;
  }
  async createInvite(workspaceId: string, role: Role): Promise<string> {
    const code = `inv_${nanoid(10)}`;
    this.invitesByCode.set(code, { workspaceId, role });
    return code;
  }
  async getInvite(code: string): Promise<{ workspaceId: string; role: Role } | null> {
    return this.invitesByCode.get(code) ?? null;
  }
}
