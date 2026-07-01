import { useState } from "react";
import { IoPencil, IoTrashOutline, IoHappyOutline, IoChatbubbleOutline } from "react-icons/io5";
import type { Reaction } from "@loose/core";
import type { UiMessage } from "../state";
import { COMMON_EMOJIS } from "../state";
import { relativeTime } from "../lib/util";
import { renderWithMentions } from "../lib/mentions";
import { Blocks } from "./Blocks";
import { Attachments } from "./Attachments";

export function MessageRow({
  message,
  reactions,
  meId,
  meName,
  mentionNames = [],
  replyCount,
  onToggleReaction,
  onOpenThread,
  onEdit,
  onDelete,
}: {
  message: UiMessage;
  reactions: Reaction[];
  meId: string;
  meName?: string;
  mentionNames?: string[];
  replyCount: number;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenThread?: (messageId: string) => void;
  onEdit?: (messageId: string, body: string) => void;
  onDelete?: (messageId: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const isRich = message.kind !== "human" && message.blocks && message.blocks.length > 0;
  const isDeleted = message.deletedAt != null;
  const isEdited = message.editedAt != null;
  // Edit/delete only for my own, non-deleted, human messages (and not optimistic).
  const canModify =
    !isDeleted &&
    !message.pending &&
    message.kind === "human" &&
    message.userId === meId &&
    (Boolean(onEdit) || Boolean(onDelete));

  function commitEdit() {
    const text = draft.trim();
    setEditing(false);
    if (text && text !== message.body) onEdit?.(message.id, text);
  }

  if (isDeleted) {
    return (
      <div className="msg">
        <div className="msg-head">
          <span className={`author ${message.kind !== "human" ? "nonhuman" : ""}`}>
            {message.userName}
          </span>
          <span className="ts">{relativeTime(message.createdAt)}</span>
        </div>
        <div className="body tombstone">This message was deleted.</div>
      </div>
    );
  }

  return (
    <div className={`msg ${message.pending ? "pending" : ""}`}>
      <div className="msg-head">
        <span className={`author ${message.kind !== "human" ? "nonhuman" : ""}`}>
          {message.userName}
        </span>
        {message.kind !== "human" && <span className="kind-badge">{message.kind}</span>}
        <span className="ts">{relativeTime(message.createdAt)}</span>
        {canModify && !editing && (
          <span className="msg-actions">
            {onEdit && (
              <button
                className="msg-action-btn"
                title="Edit message"
                onClick={() => {
                  setDraft(message.body);
                  setEditing(true);
                }}
              >
                <IoPencil />
              </button>
            )}
            {onDelete && (
              <button
                className="msg-action-btn"
                title="Delete message"
                onClick={() => {
                  if (window.confirm("Delete this message?")) onDelete(message.id);
                }}
              >
                <IoTrashOutline />
              </button>
            )}
          </span>
        )}
      </div>

      {editing ? (
        <div className="msg-edit">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="msg-edit-actions">
            <button className="msg-edit-save" onClick={commitEdit}>
              Save
            </button>
            <button className="link-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : isRich ? (
        <Blocks blocks={message.blocks!} />
      ) : (
        message.body && (
          <div className="body">
            {renderWithMentions(message.body, mentionNames, meName)}
            {isEdited && <span className="edited-marker"> (edited)</span>}
          </div>
        )
      )}

      {message.attachments && message.attachments.length > 0 && (
        <Attachments attachments={message.attachments} />
      )}

      <div className="msg-footer">
        {reactions.map((r) => {
          const mine = r.userIds.includes(meId);
          return (
            <button
              key={r.emoji}
              className={`reaction-chip ${mine ? "mine" : ""}`}
              onClick={() => onToggleReaction(message.id, r.emoji)}
            >
              <span>{r.emoji}</span>
              <span className="count">{r.userIds.length}</span>
            </button>
          );
        })}

        <div className="react-add">
          <button
            className="react-add-btn"
            title="Add reaction"
            onClick={() => setShowPicker((s) => !s)}
          >
            <IoHappyOutline />
          </button>
          {showPicker && (
            <div className="emoji-pop">
              {COMMON_EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    onToggleReaction(message.id, e);
                    setShowPicker(false);
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>

        {onOpenThread && (
          <button className="thread-link" onClick={() => onOpenThread(message.id)}>
            <IoChatbubbleOutline />
            {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Reply"}
          </button>
        )}
      </div>
    </div>
  );
}
