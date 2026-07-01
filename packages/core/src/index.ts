import { z } from "zod";

export const DEFAULT_WORKSPACE = "w_main";

// ── Domain ───────────────────────────────────────────────────────
export const UserKind = z.enum(["human", "bot", "agent"]);
export const User = z.object({
  id: z.string(),
  workspaceId: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
  kind: UserKind.default("human"),
});
export type User = z.infer<typeof User>;

export const ChannelKind = z.enum(["public", "private", "dm"]);
export const Channel = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  kind: ChannelKind,
  source: z.string().default("native"), // native | bridged:slack
  topic: z.string().nullable().optional(),
  members: z.array(z.string()).optional(), // populated for DMs so clients can resolve the partner
});
export type Channel = z.infer<typeof Channel>;

/** Rich/actionable blocks for system + bot/agent messages. */
export const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("section"), text: z.string() }),
  z.object({ type: z.literal("context"), text: z.string() }),
  z.object({ type: z.literal("divider") }),
  z.object({
    type: z.literal("actions"),
    buttons: z.array(
      z.object({
        text: z.string(),
        actionId: z.string(),
        url: z.string().optional(),
        style: z.enum(["default", "primary", "danger"]).optional(),
      }),
    ),
  }),
]);
export type Block = z.infer<typeof Block>;

export const Attachment = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  url: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

export const MessageKind = z.enum(["human", "system", "agent"]);
export const Message = z.object({
  id: z.string(),
  channelId: z.string(),
  userId: z.string(),
  userName: z.string(),
  kind: MessageKind.default("human"),
  body: z.string(),
  blocks: z.array(Block).nullable().optional(),
  attachments: z.array(Attachment).nullable().optional(),
  threadRootId: z.string().nullable().optional(),
  replyCount: z.number().optional(),
  createdAt: z.number(), // epoch ms
  editedAt: z.number().nullable().optional(),
  deletedAt: z.number().nullable().optional(),
});
export type Message = z.infer<typeof Message>;

export const Reaction = z.object({
  messageId: z.string(),
  emoji: z.string(),
  userIds: z.array(z.string()),
});
export type Reaction = z.infer<typeof Reaction>;

// ── WS protocol: client → server ─────────────────────────────────
export const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), sessionToken: z.string() }),
  z.object({ type: z.literal("channel.subscribe"), channelId: z.string() }),
  z.object({ type: z.literal("channel.more"), channelId: z.string(), before: z.number() }),
  z.object({
    type: z.literal("message.send"),
    channelId: z.string(),
    clientId: z.string(),
    body: z.string().min(1).max(8000),
    threadRootId: z.string().optional(),
  }),
  z.object({ type: z.literal("message.edit"), channelId: z.string(), messageId: z.string(), body: z.string().min(1).max(8000) }),
  z.object({ type: z.literal("message.delete"), channelId: z.string(), messageId: z.string() }),
  z.object({ type: z.literal("reaction.add"), messageId: z.string(), channelId: z.string(), emoji: z.string() }),
  z.object({ type: z.literal("reaction.remove"), messageId: z.string(), channelId: z.string(), emoji: z.string() }),
  z.object({ type: z.literal("typing.start"), channelId: z.string() }),
  z.object({ type: z.literal("channel.read"), channelId: z.string() }),
  z.object({
    type: z.literal("agent.invoke"),
    channelId: z.string(),
    threadRootId: z.string().optional(),
    prompt: z.string().min(1).max(8000),
  }),
  z.object({ type: z.literal("huddle.join"), channelId: z.string() }),
  z.object({ type: z.literal("huddle.leave"), channelId: z.string() }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

// ── WS protocol: server → client ─────────────────────────────────
export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth.ok"), user: User, channels: z.array(Channel) }),
  z.object({
    type: z.literal("channel.history"),
    channelId: z.string(),
    messages: z.array(Message),
    reactions: z.array(Reaction),
  }),
  z.object({ type: z.literal("message.new"), clientId: z.string().optional(), message: Message }),
  z.object({ type: z.literal("message.updated"), message: Message }),
  z.object({
    type: z.literal("channel.page"),
    channelId: z.string(),
    messages: z.array(Message),
    reactions: z.array(Reaction),
    hasMore: z.boolean(),
  }),
  z.object({ type: z.literal("channel.created"), channel: Channel }),
  z.object({ type: z.literal("reaction.changed"), reaction: Reaction }),
  z.object({ type: z.literal("typing"), channelId: z.string(), userId: z.string(), userName: z.string() }),
  z.object({ type: z.literal("presence.changed"), online: z.array(z.string()) }),
  z.object({ type: z.literal("read.updated"), channelId: z.string(), userId: z.string(), at: z.number() }),
  z.object({
    type: z.literal("agent.run.delta"),
    runId: z.string(),
    channelId: z.string(),
    threadRootId: z.string().nullable().optional(),
    agentName: z.string(),
    text: z.string(), // incremental token(s)
  }),
  z.object({ type: z.literal("agent.run.done"), runId: z.string(), channelId: z.string(), messageId: z.string() }),
  z.object({
    type: z.literal("huddle.state"),
    channelId: z.string(),
    active: z.boolean(),
    participants: z.array(z.object({ userId: z.string(), userName: z.string() })),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;

export const HuddleParticipant = z.object({ userId: z.string(), userName: z.string() });
export type HuddleParticipant = z.infer<typeof HuddleParticipant>;
