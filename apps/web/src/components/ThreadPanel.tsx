import { IoClose } from "react-icons/io5";
import type { Reaction } from "@loose/core";
import type { LooseState, UiMessage } from "../state";
import { MessageRow } from "./MessageRow";
import { Composer } from "./Composer";
import { AgentBubble } from "./AgentBubble";

export function ThreadPanel({
  state,
  channelId,
  rootId,
  onClose,
}: {
  state: LooseState;
  channelId: string;
  rootId: string;
  onClose: () => void;
}) {
  const data = state.getChannelData(channelId);
  const messages: UiMessage[] = data?.messages ?? [];
  const reactions: Reaction[] = data?.reactions ?? [];

  const root = messages.find((m) => m.id === rootId);
  const replies = messages
    .filter((m) => m.threadRootId === rootId)
    .sort((a, b) => a.createdAt - b.createdAt);

  const reactionsFor = (id: string) => reactions.filter((r) => r.messageId === id);

  const liveRuns = state.liveRunsFor(channelId, rootId);

  return (
    <section className="thread-panel">
      <div className="thread-head">
        <strong>Thread</strong>
        <button className="icon-btn" onClick={onClose}>
          <IoClose />
        </button>
      </div>
      <div className="thread-body">
        {root && (
          <MessageRow
            message={root}
            reactions={reactionsFor(root.id)}
            meId={state.me.id}
            replyCount={0}
            onToggleReaction={(mid, emoji) => state.toggleReaction(channelId, mid, emoji)}
            onEdit={(mid, body) => state.editMessage(channelId, mid, body)}
            onDelete={(mid) => state.deleteMessage(channelId, mid)}
          />
        )}
        <div className="thread-divider">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </div>
        {replies.map((m) => (
          <MessageRow
            key={m.id}
            message={m}
            reactions={reactionsFor(m.id)}
            meId={state.me.id}
            replyCount={0}
            onToggleReaction={(mid, emoji) => state.toggleReaction(channelId, mid, emoji)}
            onEdit={(mid, body) => state.editMessage(channelId, mid, body)}
            onDelete={(mid) => state.deleteMessage(channelId, mid)}
          />
        ))}
        {liveRuns.map((r) => (
          <AgentBubble key={r.runId} run={r} />
        ))}
      </div>
      <Composer
        placeholder="Reply…"
        onSend={(body) => state.sendMessage(channelId, body, rootId)}
        onTyping={() => state.typingIn(channelId)}
        onAttach={(file) => state.uploadFile(channelId, file)}
        onAsk={(prompt) => state.invokeAgent(channelId, prompt, rootId)}
      />
    </section>
  );
}
