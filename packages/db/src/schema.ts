import { pgTable, text, timestamp, jsonb, bigint, integer, primaryKey, index } from "drizzle-orm/pg-core";

// Multi-tenant-ready from day one: workspace_id on every row, single-tenant in behavior.

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  plan: text("plan").notNull().default("free"), // free | pro
  seatLimit: integer("seat_limit").notNull().default(50),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // owner | admin | member
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email"), // set for humans; null for bots/system
  avatarUrl: text("avatar_url"),
  kind: text("kind").notNull().default("human"), // human | bot | agent | system
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("public"), // public | private | dm
  source: text("source").notNull().default("native"), // native | bridged:slack
  topic: text("topic"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull(), // denormalized author label (connector/bot/user)
    kind: text("kind").notNull().default("human"), // human | system | agent
    body: text("body").notNull(),
    blocks: jsonb("blocks"), // rich/actionable card payloads (system + agent messages)
    attachments: jsonb("attachments"), // file attachments
    threadRootId: text("thread_root_id"), // set on thread replies
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("messages_channel_created_idx").on(t.channelId, t.createdAt)],
);

export const credentials = pgTable("credentials", {
  userId: text("user_id").primaryKey(),
  type: text("type").notNull().default("password"), // password | oauth | saml
  secretHash: text("secret_hash").notNull(),
});

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: text("channel_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
    lastReadAt: bigint("last_read_at", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })],
);

export const reactions = pgTable(
  "reactions",
  {
    messageId: text("message_id").notNull(),
    userId: text("user_id").notNull(),
    emoji: text("emoji").notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

export const bots = pgTable("bots", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
