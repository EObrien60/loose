import { useEffect, useMemo, useState } from "react";
import type { User } from "@loose/core";
import { IoClose, IoSearchOutline, IoChatbubbleOutline } from "react-icons/io5";
import { api, ApiError } from "../lib/api";
import type { LooseState } from "../state";

/**
 * Workspace people directory — searchable list of everyone, with live presence and
 * a one-click DM. Available to every member (not just admins).
 */
export function Directory({
  state,
  people,
  onRefresh,
  onStartDm,
  onClose,
}: {
  state: LooseState;
  people: User[];
  onRefresh: () => void;
  onStartDm: (channelId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Refresh on open so a just-joined teammate shows up.
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const others = useMemo(() => people.filter((u) => u.id !== state.me.id), [people, state.me.id]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? others.filter((u) => u.displayName.toLowerCase().includes(q)) : others;
    return [...list].sort((a, b) => {
      // online first, then alphabetical
      const ao = state.online.has(a.id) ? 0 : 1;
      const bo = state.online.has(b.id) ? 0 : 1;
      return ao - bo || a.displayName.localeCompare(b.displayName);
    });
  }, [others, query, state.online]);

  async function message(userId: string) {
    setBusy(userId);
    setErr(null);
    try {
      const { channel } = await api.createDm(userId);
      state.addChannel(channel);
      onStartDm(channel.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed to start DM");
    } finally {
      setBusy(null);
    }
  }

  const onlineCount = others.filter((u) => state.online.has(u.id)).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal directory-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="directory-title">
            <strong>Directory</strong>
            <span className="directory-count">
              {others.length} {others.length === 1 ? "person" : "people"} · {onlineCount} online
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <IoClose />
          </button>
        </div>

        <div className="directory-search">
          <IoSearchOutline />
          <input
            autoFocus
            placeholder="Search people…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {err && <div className="auth-error">{err}</div>}

        <div className="directory-list set-list">
          {filtered.map((u) => {
            const isOnline = state.online.has(u.id);
            return (
              <div className="set-list-row" key={u.id}>
                <div className="set-avatar">{u.displayName.slice(0, 1).toUpperCase()}</div>
                <div className="set-list-main">
                  <div className="set-list-name">
                    {u.displayName}
                    {u.kind !== "human" && <span className="kind-badge dir-kind">{u.kind}</span>}
                  </div>
                  <div className="set-list-sub">
                    <span className={`presence-dot ${isOnline ? "online" : ""}`} />
                    {isOnline ? "Active" : "Offline"}
                  </div>
                </div>
                <button
                  className="dir-msg-btn"
                  disabled={busy === u.id}
                  onClick={() => message(u.id)}
                  title={`Message ${u.displayName}`}
                >
                  <IoChatbubbleOutline />
                  Message
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="empty-hint">
              {others.length === 0 ? "No one else here yet." : "No people match your search."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
