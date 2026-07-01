import { useEffect, useMemo, useRef, useState } from "react";
import type { Channel, Message, Reaction } from "@loose/core";
import type { LooseState, UiMessage } from "../state";
import { api } from "../lib/api";
import { relativeTime } from "../lib/util";
import { MessageRow } from "./MessageRow";
import { Composer } from "./Composer";
import { AgentBubble } from "./AgentBubble";
import { HuddlePanel } from "./HuddlePanel";

export function ChannelView({
  state,
  channel,
  onOpenThread,
}: {
  state: LooseState;
  channel: Channel;
  onOpenThread: (rootId: string) => void;
}) {
  const data = state.getChannelData(channel.id);
  const messages: UiMessage[] = data?.messages ?? [];
  const reactions: Reaction[] = data?.reactions ?? [];
  const loaded = data?.loaded ?? false;
  const hasMore = data?.hasMore ?? false;

  const scrollRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Message[] | null>(null);
  const [searching, setSearching] = useState(false);

  // top-level messages only, sorted ascending
  const timeline = useMemo(
    () =>
      messages
        .filter((m) => !m.threadRootId)
        .sort((a, b) => a.createdAt - b.createdAt),
    [messages],
  );

  const replyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of messages) {
      if (m.threadRootId) counts[m.threadRootId] = (counts[m.threadRootId] ?? 0) + 1;
    }
    return counts;
  }, [messages]);

  // auto-scroll to bottom when newer messages are appended; keep position stable
  // when older messages are prepended (load-more) by anchoring on the oldest id.
  const lastCount = useRef(0);
  const oldestIdRef = useRef<string | undefined>(undefined);
  const pendingRestore = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const prevOldest = oldestIdRef.current;
    const nextOldest = timeline[0]?.id;
    oldestIdRef.current = nextOldest;
    const grew = timeline.length !== lastCount.current;
    const prepended =
      grew && timeline.length > lastCount.current && prevOldest && nextOldest !== prevOldest;
    lastCount.current = timeline.length;
    if (!grew || !el) return;
    if (prepended && pendingRestore.current) {
      // Best-effort scroll restoration after a prepend.
      const { prevHeight, prevTop } = pendingRestore.current;
      pendingRestore.current = null;
      el.scrollTop = el.scrollHeight - prevHeight + prevTop;
    } else if (!prepended) {
      el.scrollTop = el.scrollHeight;
    }
  }, [timeline]);

  const loadMore = state.loadMore;
  function requestOlder() {
    const el = scrollRef.current;
    if (el) pendingRestore.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
    loadMore(channel.id);
  }

  // auto-load older history when scrolled near the top
  function onScroll() {
    const el = scrollRef.current;
    if (!el || !hasMore || !loaded) return;
    if (el.scrollTop < 60) requestOlder();
  }

  // mark read when viewing / new messages arrive.
  // Depend on the *stable* markRead callback — not the whole `state` object, which
  // useLoose returns fresh every render. Depending on `state` re-ran this effect on
  // every render, and each run's read.updated broadcast triggered another render,
  // creating a channel.read flood that tripped the server's WS rate limit.
  const markRead = state.markRead;
  useEffect(() => {
    markRead(channel.id);
  }, [channel.id, timeline.length, markRead]);

  const reactionsFor = (id: string) => reactions.filter((r) => r.messageId === id);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await api.search(q);
      setResults(res.messages);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  // top-level live agent runs (no thread root) for this channel
  const liveRuns = state.liveRunsFor(channel.id, null);

  // keep pinned to bottom as streaming text grows
  const liveLen = liveRuns.reduce((n, r) => n + r.text.length, 0);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveLen]);

  const typing = state.typingNames(channel.id);
  const isDm = channel.kind === "dm";

  const huddle = state.huddleFor(channel.id);
  const inThisHuddle = state.activeHuddleChannelId === channel.id;
  const huddleActiveElsewhere = (huddle?.active ?? false) && !inThisHuddle;

  // Leave the huddle when navigating away from this channel (or unmounting):
  // v1 allows only one huddle at a time and ties it to the open channel.
  const leaveHuddle = state.leaveHuddle;
  useEffect(() => {
    return () => {
      leaveHuddle(channel.id);
    };
  }, [channel.id, leaveHuddle]);

  return (
    <section className="channel">
      <header>
        {!isDm && <span className="hash">{channel.kind === "private" ? "🔒" : "#"}</span>}
        <span className="chan-title">{channel.name}</span>
        {channel.topic && <span className="topic">{channel.topic}</span>}
        {inThisHuddle ? (
          <button
            className="huddle-btn active"
            onClick={() => state.leaveHuddle(channel.id)}
            title="Leave huddle"
          >
            🎧 In huddle
          </button>
        ) : huddleActiveElsewhere ? (
          <button
            className="huddle-btn join"
            onClick={() => state.joinHuddle(channel.id)}
            title="Join the huddle in progress"
          >
            🎧 Huddle in progress — Join
          </button>
        ) : (
          <button
            className="huddle-btn"
            onClick={() => state.joinHuddle(channel.id)}
            title="Start a huddle"
          >
            🎧 Huddle
          </button>
        )}
        <form className="search" onSubmit={runSearch}>
          <input
            placeholder="Search messages…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) setResults(null);
            }}
          />
        </form>
      </header>

      {inThisHuddle && (
        <HuddlePanel state={state} channelId={channel.id} channelName={channel.name} />
      )}

      {results !== null ? (
        <div className="messages search-results">
          <div className="search-head">
            <strong>
              {searching ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"}`}
            </strong>
            <button
              className="link-btn"
              onClick={() => {
                setResults(null);
                setQuery("");
              }}
            >
              Clear
            </button>
          </div>
          {results.map((m) => (
            <div key={m.id} className="search-row">
              <div className="msg-head">
                <span className="author">{m.userName}</span>
                <span className="ts">{relativeTime(m.createdAt)}</span>
              </div>
              <div className="body">{m.body}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {!loaded && <div className="empty-hint">Loading…</div>}
          {loaded && hasMore && timeline.length > 0 && (
            <button className="load-older" onClick={requestOlder}>
              Load older messages
            </button>
          )}
          {loaded && timeline.length === 0 && (
            <div className="empty-hint">No messages yet. Say hello 👋</div>
          )}
          {timeline.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              reactions={reactionsFor(m.id)}
              meId={state.me.id}
              replyCount={m.replyCount ?? replyCounts[m.id] ?? 0}
              onToggleReaction={(mid, emoji) => state.toggleReaction(channel.id, mid, emoji)}
              onOpenThread={onOpenThread}
              onEdit={(mid, body) => state.editMessage(channel.id, mid, body)}
              onDelete={(mid) => state.deleteMessage(channel.id, mid)}
            />
          ))}
          {liveRuns.map((r) => (
            <AgentBubble key={r.runId} run={r} />
          ))}
        </div>
      )}

      {typing.length > 0 && (
        <div className="typing-line">
          {typing.join(", ")} {typing.length === 1 ? "is" : "are"} typing…
        </div>
      )}

      <Composer
        placeholder={isDm ? `Message ${channel.name}` : `Message #${channel.name}`}
        onSend={(body) => state.sendMessage(channel.id, body)}
        onTyping={() => state.typingIn(channel.id)}
        onAttach={(file) => state.uploadFile(channel.id, file)}
        onAsk={(prompt) => state.invokeAgent(channel.id, prompt)}
      />
    </section>
  );
}
