import { useCallback, useEffect, useRef, useState } from "react";
import type { User, Channel, Message, Reaction, ServerMsg } from "@loose/core";
import { connect, type Connection } from "./ws";
import { WS_URL } from "./api";
import { uuid } from "./util";

export interface PendingFlag {
  pending?: boolean;
}
export type UiMessage = Message & PendingFlag;

interface ChannelData {
  messages: UiMessage[];
  reactions: Reaction[];
  loaded: boolean;
}

export interface LooseState {
  me: User;
  channels: Channel[];
  status: "connecting" | "open" | "closed";
  getChannelData: (channelId: string) => ChannelData | undefined;
  subscribe: (channelId: string) => void;
  sendMessage: (channelId: string, body: string) => void;
  deleteMessage: (channelId: string, messageId: string) => void;
}

const EMPTY_CHANNEL: ChannelData = { messages: [], reactions: [], loaded: false };

export function useLoose(sessionToken: string, initialUser: User): LooseState {
  const [me] = useState(initialUser);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");

  // channel data lives in a ref + a version counter to keep re-renders cheap & correct.
  const dataRef = useRef<Record<string, ChannelData>>({});
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const connRef = useRef<Connection | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());

  const setChannelData = useCallback(
    (channelId: string, fn: (d: ChannelData) => ChannelData) => {
      const cur = dataRef.current[channelId] ?? EMPTY_CHANNEL;
      dataRef.current[channelId] = fn(cur);
      rerender();
    },
    [rerender],
  );

  const onMessage = useCallback(
    (m: ServerMsg) => {
      switch (m.type) {
        case "auth.ok": {
          setChannels(m.channels);
          break;
        }
        case "channel.history": {
          dataRef.current[m.channelId] = {
            messages: m.messages,
            reactions: m.reactions,
            loaded: true,
          };
          rerender();
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
          break;
        }
        case "message.updated": {
          const msg = m.message;
          setChannelData(msg.channelId, (d) => {
            const idx = d.messages.findIndex((x) => x.id === msg.id);
            if (idx < 0) return d;
            const messages = d.messages.slice();
            // preserve any local-only flags (e.g. pending) on replace
            messages[idx] = { ...messages[idx], ...msg };
            return { ...d, messages };
          });
          break;
        }
        case "channel.created": {
          setChannels((prev) =>
            prev.some((c) => c.id === m.channel.id) ? prev : [...prev, m.channel],
          );
          break;
        }
        default:
          break;
      }
    },
    [rerender, setChannelData],
  );

  // connect once per session token
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

  const subscribe = useCallback((channelId: string) => {
    if (!channelId) return;
    subscribedRef.current.add(channelId);
    connRef.current?.send({ type: "channel.subscribe", channelId });
  }, []);

  const sendMessage = useCallback(
    (channelId: string, body: string) => {
      const text = body.trim();
      if (!text) return;
      const clientId = uuid();
      const optimistic: UiMessage = {
        id: clientId,
        channelId,
        userId: me.id,
        userName: me.displayName,
        kind: "human",
        body: text,
        threadRootId: null,
        createdAt: Date.now(),
        pending: true,
      };
      setChannelData(channelId, (d) => ({ ...d, messages: [...d.messages, optimistic] }));
      connRef.current?.send({ type: "message.send", channelId, clientId, body: text });
    },
    [me.id, me.displayName, setChannelData],
  );

  const deleteMessage = useCallback((channelId: string, messageId: string) => {
    connRef.current?.send({ type: "message.delete", channelId, messageId });
  }, []);

  const getChannelData = useCallback((channelId: string) => dataRef.current[channelId], []);

  return { me, channels, status, getChannelData, subscribe, sendMessage, deleteMessage };
}

/** Human-friendly label for a channel in the list / header. */
export function channelLabel(channel: Channel, meId: string): string {
  if (channel.kind === "dm") {
    const partner = (channel.members ?? []).filter((id) => id !== meId);
    return partner.length ? `@ ${partner.join(", ")}` : channel.name || "Direct message";
  }
  return `#${channel.name}`;
}
