import { useCallback, useEffect, useRef, useState } from "react";
import type {
  User,
  Channel,
  Message,
  Reaction,
  ServerMsg,
  HuddleParticipant,
} from "@loose/core";
import { connect, type Connection } from "./lib/ws";
import { WS_URL, api } from "./lib/api";
import { uuid } from "./lib/util";
import { capture } from "./lib/analytics";

export const COMMON_EMOJIS = ["👍", "🎉", "❤️", "😄", "🚀", "👀"];

export interface PendingFlag {
  pending?: boolean;
}
export type UiMessage = Message & PendingFlag;

interface ChannelData {
  messages: UiMessage[];
  reactions: Reaction[];
  loaded: boolean;
  /** Whether older history remains to be paged in (defaults to true until told otherwise). */
  hasMore: boolean;
}

/** Authoritative roster (over WS) of who is in a channel's huddle. */
export interface HuddleInfo {
  active: boolean;
  participants: HuddleParticipant[];
}

/** A live (streaming) agent run, keyed by runId, scoped to a channel/thread. */
export interface LiveAgentRun {
  runId: string;
  channelId: string;
  threadRootId: string | null;
  agentName: string;
  text: string;
}

export interface LooseState {
  me: User;
  channels: Channel[];
  online: Set<string>;
  /** channelId -> last-read epoch ms for me */
  reads: Record<string, number>;
  /** channelId -> latest message createdAt seen */
  latest: Record<string, number>;
  conn: { status: "connecting" | "open" | "closed" };
  getChannelData: (channelId: string) => ChannelData | undefined;
  /** Live agent runs for a channel, optionally filtered to a thread root. */
  liveRunsFor: (channelId: string, threadRootId?: string | null) => LiveAgentRun[];
  subscribe: (channelId: string) => void;
  /** Request older history for a channel (sends channel.more with the oldest loaded createdAt). */
  loadMore: (channelId: string) => void;
  sendMessage: (channelId: string, body: string, threadRootId?: string) => void;
  editMessage: (channelId: string, messageId: string, body: string) => void;
  deleteMessage: (channelId: string, messageId: string) => void;
  invokeAgent: (channelId: string, prompt: string, threadRootId?: string) => void;
  uploadFile: (channelId: string, file: File) => Promise<void>;
  toggleReaction: (channelId: string, messageId: string, emoji: string) => void;
  typingIn: (channelId: string) => void;
  markRead: (channelId: string) => void;
  typingNames: (channelId: string) => string[];
  addChannel: (channel: Channel) => void;
  focusChannel: (channelId: string) => void;
  /** Authoritative WS roster for a channel's huddle (or undefined if none seen). */
  huddleFor: (channelId: string) => HuddleInfo | undefined;
  /** The channel id of the huddle the local user has joined, if any. */
  activeHuddleChannelId: string | null;
  /** Join a channel's huddle roster (sends huddle.join over WS). */
  joinHuddle: (channelId: string) => void;
  /** Leave a channel's huddle roster (sends huddle.leave over WS). */
  leaveHuddle: (channelId: string) => void;
}

const EMPTY_CHANNEL: ChannelData = { messages: [], reactions: [], loaded: false, hasMore: true };

/** Merge reactions, replacing any (messageId, emoji) pair present in `incoming`. */
function mergeReactions(existing: Reaction[], incoming: Reaction[]): Reaction[] {
  if (incoming.length === 0) return existing;
  const out = existing.filter(
    (x) => !incoming.some((r) => r.messageId === x.messageId && r.emoji === x.emoji),
  );
  for (const r of incoming) if (r.userIds.length) out.push(r);
  return out;
}

export function useLoose(sessionToken: string, initialUser: User): LooseState {
  const [me] = useState(initialUser);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [reads, setReads] = useState<Record<string, number>>({});
  const [latest, setLatest] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  // huddle rosters: channelId -> { active, participants } (authoritative, from WS).
  const [huddles, setHuddles] = useState<Record<string, HuddleInfo>>({});
  // the channel whose huddle the local user has joined (one at a time in v1).
  const [activeHuddleChannelId, setActiveHuddleChannelId] = useState<string | null>(null);
  // channel data lives in a ref + a version counter to keep re-renders cheap & correct.
  const dataRef = useRef<Record<string, ChannelData>>({});
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  // live agent runs: runId -> LiveAgentRun (transient streaming buffers)
  const runsRef = useRef<Record<string, LiveAgentRun>>({});
  // typing: channelId -> userId -> { name, expires }
  const typingRef = useRef<Record<string, Record<string, { name: string; expires: number }>>>({});
  const connRef = useRef<Connection | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const lastTypingSentRef = useRef<Record<string, number>>({});

  const setChannelData = useCallback(
    (channelId: string, fn: (d: ChannelData) => ChannelData) => {
      const cur = dataRef.current[channelId] ?? EMPTY_CHANNEL;
      dataRef.current[channelId] = fn(cur);
      rerender();
    },
    [rerender],
  );

  const noteLatest = useCallback((channelId: string, ts: number) => {
    setLatest((prev) => (prev[channelId] && prev[channelId] >= ts ? prev : { ...prev, [channelId]: ts }));
  }, []);

  const onMessage = useCallback(
    (m: ServerMsg) => {
      switch (m.type) {
        case "auth.ok": {
          setChannels(m.channels);
          break;
        }
        case "channel.history": {
          const prev = dataRef.current[m.channelId];
          dataRef.current[m.channelId] = {
            messages: m.messages,
            reactions: m.reactions,
            loaded: true,
            hasMore: prev?.hasMore ?? true,
          };
          const top = m.messages.reduce((acc, msg) => Math.max(acc, msg.createdAt), 0);
          if (top) noteLatest(m.channelId, top);
          rerender();
          break;
        }
        case "channel.page": {
          setChannelData(m.channelId, (d) => {
            const known = new Set(d.messages.map((x) => x.id));
            const older = m.messages.filter((x) => !known.has(x.id));
            return {
              ...d,
              messages: [...older, ...d.messages],
              reactions: mergeReactions(d.reactions, m.reactions),
              hasMore: m.hasMore,
            };
          });
          break;
        }
        case "channel.created": {
          setChannels((prev) => (prev.some((c) => c.id === m.channel.id) ? prev : [...prev, m.channel]));
          break;
        }
        case "message.updated": {
          const msg = m.message;
          setChannelData(msg.channelId, (d) => {
            const idx = d.messages.findIndex((x) => x.id === msg.id);
            if (idx < 0) return d;
            const messages = d.messages.slice();
            messages[idx] = msg;
            return { ...d, messages };
          });
          break;
        }
        case "message.new": {
          const msg = m.message;
          setChannelData(msg.channelId, (d) => {
            let messages = d.messages;
            // reconcile optimistic by clientId
            if (m.clientId) {
              const idx = messages.findIndex((x) => x.id === m.clientId || x.id === msg.id);
              if (idx >= 0) {
                messages = messages.slice();
                messages[idx] = msg;
                return { ...d, messages };
              }
            }
            // dedupe by id
            if (messages.some((x) => x.id === msg.id)) return d;
            return { ...d, messages: [...messages, msg] };
          });
          noteLatest(msg.channelId, msg.createdAt);
          break;
        }
        case "reaction.changed": {
          const r = m.reaction;
          setChannelData(
            // we don't get channelId on the reaction; find which channel holds the message.
            findChannelForMessage(dataRef.current, r.messageId) ?? "",
            (d) => {
              const others = d.reactions.filter(
                (x) => !(x.messageId === r.messageId && x.emoji === r.emoji),
              );
              const next = r.userIds.length ? [...others, r] : others;
              return { ...d, reactions: next };
            },
          );
          break;
        }
        case "typing": {
          if (m.userId === me.id) break;
          const chan = (typingRef.current[m.channelId] ??= {});
          chan[m.userId] = { name: m.userName, expires: Date.now() + 4000 };
          rerender();
          break;
        }
        case "presence.changed": {
          setOnline(new Set(m.online));
          break;
        }
        case "read.updated": {
          if (m.userId === me.id) {
            setReads((prev) => ({ ...prev, [m.channelId]: m.at }));
          }
          break;
        }
        case "agent.run.delta": {
          const cur = runsRef.current[m.runId];
          runsRef.current[m.runId] = {
            runId: m.runId,
            channelId: m.channelId,
            threadRootId: m.threadRootId ?? null,
            agentName: m.agentName,
            text: (cur?.text ?? "") + m.text,
          };
          rerender();
          break;
        }
        case "agent.run.done": {
          // The final agent message already arrives as a normal message.new
          // (kind:"agent"); just drop the live buffer for this run.
          if (runsRef.current[m.runId]) {
            delete runsRef.current[m.runId];
            rerender();
          }
          break;
        }
        case "huddle.state": {
          setHuddles((prev) => ({
            ...prev,
            [m.channelId]: { active: m.active, participants: m.participants },
          }));
          break;
        }
        case "error": {
          // eslint-disable-next-line no-console
          console.warn("[loose] server error:", m.message);
          break;
        }
      }
    },
    [me.id, noteLatest, rerender, setChannelData],
  );

  // connect once
  useEffect(() => {
    const conn = connect(WS_URL, sessionToken, {
      onMessage,
      onStatus: setStatus,
      onOpen: () => {
        // re-subscribe to channels we had open
        for (const id of subscribedRef.current) {
          conn.send({ type: "channel.subscribe", channelId: id });
        }
      },
    });
    connRef.current = conn;
    return () => conn.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  // prune expired typing indicators
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const chan of Object.values(typingRef.current)) {
        for (const [uid, info] of Object.entries(chan)) {
          if (info.expires < now) {
            delete chan[uid];
            changed = true;
          }
        }
      }
      if (changed) rerender();
    }, 1500);
    return () => clearInterval(t);
  }, [rerender]);

  const subscribe = useCallback((channelId: string) => {
    if (!channelId) return;
    subscribedRef.current.add(channelId);
    connRef.current?.send({ type: "channel.subscribe", channelId });
  }, []);

  const loadMore = useCallback((channelId: string) => {
    if (!channelId) return;
    const d = dataRef.current[channelId];
    if (!d || !d.loaded || !d.hasMore || d.messages.length === 0) return;
    const before = d.messages.reduce(
      (min, msg) => Math.min(min, msg.createdAt),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(before)) return;
    connRef.current?.send({ type: "channel.more", channelId, before });
  }, []);

  const markRead = useCallback((channelId: string) => {
    if (!channelId) return;
    connRef.current?.send({ type: "channel.read", channelId });
  }, []);

  const focusChannel = useCallback(
    (channelId: string) => {
      subscribe(channelId);
      markRead(channelId);
    },
    [subscribe, markRead],
  );

  const sendMessage = useCallback(
    (channelId: string, body: string, threadRootId?: string) => {
      const text = body.trim();
      if (!text) return;
      const clientId = uuid();
      // optimistic message
      const optimistic: UiMessage = {
        id: clientId,
        channelId,
        userId: me.id,
        userName: me.displayName,
        kind: "human",
        body: text,
        threadRootId: threadRootId ?? null,
        createdAt: Date.now(),
        pending: true,
      };
      setChannelData(channelId, (d) => ({ ...d, messages: [...d.messages, optimistic] }));
      noteLatest(channelId, optimistic.createdAt);
      connRef.current?.send({
        type: "message.send",
        channelId,
        clientId,
        body: text,
        ...(threadRootId ? { threadRootId } : {}),
      });
      capture("message_sent");
    },
    [me.id, me.displayName, noteLatest, setChannelData],
  );

  const editMessage = useCallback((channelId: string, messageId: string, body: string) => {
    const text = body.trim();
    if (!text) return;
    connRef.current?.send({ type: "message.edit", channelId, messageId, body: text });
  }, []);

  const deleteMessage = useCallback((channelId: string, messageId: string) => {
    connRef.current?.send({ type: "message.delete", channelId, messageId });
  }, []);

  const invokeAgent = useCallback((channelId: string, prompt: string, threadRootId?: string) => {
    const text = prompt.trim();
    if (!text) return;
    connRef.current?.send({
      type: "agent.invoke",
      channelId,
      prompt: text,
      ...(threadRootId ? { threadRootId } : {}),
    });
    capture("agent_invoked");
  }, []);

  const uploadFile = useCallback(async (channelId: string, file: File) => {
    // The server broadcasts the resulting message over the WS, and state dedupes
    // by id — so we do not insert anything here; we just fire the upload.
    await api.uploadFile(channelId, file);
    capture("file_uploaded");
  }, []);

  const liveRunsFor = useCallback(
    (channelId: string, threadRootId?: string | null): LiveAgentRun[] => {
      const want = threadRootId ?? null;
      return Object.values(runsRef.current).filter(
        (r) => r.channelId === channelId && (r.threadRootId ?? null) === want,
      );
    },
    [],
  );

  const toggleReaction = useCallback(
    (channelId: string, messageId: string, emoji: string) => {
      const d = dataRef.current[channelId];
      const existing = d?.reactions.find((r) => r.messageId === messageId && r.emoji === emoji);
      const mine = existing?.userIds.includes(me.id) ?? false;
      connRef.current?.send({
        type: mine ? "reaction.remove" : "reaction.add",
        messageId,
        channelId,
        emoji,
      });
    },
    [me.id],
  );

  const typingIn = useCallback((channelId: string) => {
    const now = Date.now();
    const last = lastTypingSentRef.current[channelId] ?? 0;
    if (now - last < 2000) return;
    lastTypingSentRef.current[channelId] = now;
    connRef.current?.send({ type: "typing.start", channelId });
  }, []);

  const typingNames = useCallback((channelId: string): string[] => {
    const chan = typingRef.current[channelId];
    if (!chan) return [];
    const now = Date.now();
    return Object.values(chan)
      .filter((x) => x.expires > now)
      .map((x) => x.name);
  }, []);

  const getChannelData = useCallback((channelId: string) => dataRef.current[channelId], []);

  const addChannel = useCallback((channel: Channel) => {
    setChannels((prev) => (prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]));
  }, []);

  const huddleFor = useCallback(
    (channelId: string): HuddleInfo | undefined => huddles[channelId],
    [huddles],
  );

  const leaveHuddle = useCallback((channelId: string) => {
    if (!channelId) return;
    // Only act if we're actually in this channel's huddle (avoids spurious
    // leave frames from cleanup effects on channels we never joined).
    setActiveHuddleChannelId((cur) => {
      if (cur !== channelId) return cur;
      connRef.current?.send({ type: "huddle.leave", channelId });
      return null;
    });
  }, []);

  const joinHuddle = useCallback(
    (channelId: string) => {
      if (!channelId) return;
      // v1: only one huddle at a time — leave any other huddle first.
      setActiveHuddleChannelId((cur) => {
        if (cur && cur !== channelId) {
          connRef.current?.send({ type: "huddle.leave", channelId: cur });
        }
        return channelId;
      });
      connRef.current?.send({ type: "huddle.join", channelId });
    },
    [],
  );

  return {
    me,
    channels,
    online,
    reads,
    latest,
    conn: { status },
    getChannelData,
    liveRunsFor,
    subscribe,
    loadMore,
    sendMessage,
    editMessage,
    deleteMessage,
    invokeAgent,
    uploadFile,
    toggleReaction,
    typingIn,
    markRead,
    typingNames,
    addChannel,
    focusChannel,
    huddleFor,
    activeHuddleChannelId,
    joinHuddle,
    leaveHuddle,
  };
}

function findChannelForMessage(
  data: Record<string, ChannelData>,
  messageId: string,
): string | undefined {
  for (const [channelId, d] of Object.entries(data)) {
    if (d.messages.some((m) => m.id === messageId)) return channelId;
  }
  return undefined;
}
