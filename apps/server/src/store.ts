import type { Attachment, Block, Channel, Message, Reaction } from "@loose/core";
import type { CredentialRepo, SessionRepo, UserRecord, UserRepo } from "@loose/auth";

export interface AppendInput {
  channelId: string;
  userId: string;
  userName: string;
  body: string;
  kind?: Message["kind"];
  blocks?: Block[];
  attachments?: Attachment[];
  threadRootId?: string;
  createdAt?: number; // override insertion time (e.g. imported Slack history)
}

export type StoredUser = UserRecord & { avatarUrl?: string | null };

export type Role = "owner" | "admin" | "member";
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string; // free | pro
  seatLimit: number;
  stripeCustomerId?: string | null;
}
export interface Member {
  userId: string;
  role: Role;
  displayName: string;
  email: string;
}

/**
 * The single persistence contract. MemoryStore and PgStore both implement it.
 * Everything is async so the Postgres-backed implementation is a drop-in.
 */
export interface Store {
  kind: string;
  users: UserRepo;
  creds: CredentialRepo;
  sessions: SessionRepo;

  systemUser(): Promise<StoredUser>;
  getUser(id: string): Promise<StoredUser | null>;
  listHumans(workspaceId: string): Promise<UserRecord[]>;
  /** Update editable profile fields; returns the updated user (or null if missing). */
  updateUserProfile(userId: string, patch: { displayName?: string }): Promise<StoredUser | null>;

  // ── workspaces / tenancy ──
  createWorkspace(name: string, slug: string): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  getWorkspaceBySlug(slug: string): Promise<Workspace | null>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  setPlan(workspaceId: string, plan: string, seatLimit: number): Promise<void>;
  setStripeCustomer(workspaceId: string, customerId: string): Promise<void>;

  addMember(workspaceId: string, userId: string, role: Role): Promise<void>;
  getRole(workspaceId: string, userId: string): Promise<Role | null>;
  listMembers(workspaceId: string): Promise<Member[]>;
  setRole(workspaceId: string, userId: string, role: Role): Promise<void>;
  memberCount(workspaceId: string): Promise<number>;

  createInvite(workspaceId: string, role: Role): Promise<string>;
  getInvite(code: string): Promise<{ workspaceId: string; role: Role } | null>;

  createChannel(workspaceId: string, name: string, kind: Channel["kind"], creatorId?: string): Promise<Channel>;
  getChannel(id: string): Promise<Channel | null>;
  getChannelByName(workspaceId: string, name: string): Promise<Channel | null>;
  ensureChannel(workspaceId: string, name: string): Promise<Channel>;
  isMember(channelId: string, userId: string): Promise<boolean>;
  canAccess(channelId: string, userId: string): Promise<boolean>;
  join(channelId: string, userId: string): Promise<void>;
  getOrCreateDm(workspaceId: string, a: string, b: string): Promise<Channel>;
  listChannelsForUser(userId: string): Promise<Channel[]>;

  append(input: AppendInput): Promise<Message>;
  history(channelId: string, limit: number): Promise<{ messages: Message[]; reactions: Reaction[] }>;
  /** Older page for infinite scroll: messages with createdAt < before, newest-first window. */
  historyBefore(channelId: string, before: number, limit: number): Promise<{ messages: Message[]; reactions: Reaction[]; hasMore: boolean }>;
  getMessage(id: string): Promise<Message | null>;
  /** Author-only edit; returns the updated message, or null if missing/not author/deleted. */
  editMessage(messageId: string, userId: string, body: string): Promise<Message | null>;
  /** Author-only soft delete (tombstone); returns the updated message, or null if missing/not author. */
  deleteMessage(messageId: string, userId: string): Promise<Message | null>;
  search(userId: string, query: string, limit?: number): Promise<Message[]>;

  addReaction(messageId: string, emoji: string, userId: string): Promise<Reaction>;
  removeReaction(messageId: string, emoji: string, userId: string): Promise<Reaction>;
  reactionsFor(messageIds: string[]): Promise<Reaction[]>;

  setRead(channelId: string, userId: string, at: number): Promise<void>;
  getRead(channelId: string, userId: string): Promise<number>;

  createBot(workspaceId: string, name: string): Promise<{ user: UserRecord; token: string }>;
  findBotByToken(token: string): Promise<UserRecord | null>;

  close?(): Promise<void>;
}

/**
 * Store selection by env:
 *   DATABASE_URL=postgres://…   → Postgres (Neon, prod)
 *   DATABASE_URL=pglite://<dir> → embedded PGlite (durable single-box / tests)
 *   (unset)                     → in-memory (ephemeral dev default)
 */
export async function createStore(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { PgStore } = await import("./store.pg");
    return PgStore.create(url);
  }
  const { MemoryStore } = await import("./store.memory");
  return new MemoryStore();
}
