import { useState } from "react";
import { IoSettingsOutline, IoAdd, IoLockClosed, IoClose } from "react-icons/io5";
import type { User, Channel } from "@loose/core";
import { api, type WorkspaceInfo, type WorkspaceRole } from "../lib/api";
import type { LooseState } from "../state";
import { AdminPanel } from "./AdminPanel";

function channelLabel(c: Channel, me: User, dmNames: Record<string, string>): string {
  if (c.kind === "dm") return dmNames[c.id] ?? c.name ?? "Direct message";
  return c.name;
}

export function Sidebar({
  state,
  activeId,
  onSelect,
  onLogout,
  workspace,
  role,
}: {
  state: LooseState;
  activeId: string | null;
  onSelect: (channelId: string) => void;
  onLogout: () => void;
  workspace: WorkspaceInfo | null;
  role: WorkspaceRole | null;
}) {
  const { me, channels, online, reads, latest } = state;
  const [showDmPicker, setShowDmPicker] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [users, setUsers] = useState<User[] | null>(null);
  const [usersErr, setUsersErr] = useState<string | null>(null);

  const rooms = channels.filter((c) => c.kind === "public" || c.kind === "private");
  const dms = channels.filter((c) => c.kind === "dm");

  // Map of dm channelId -> partner display name (best effort from loaded users).
  const dmNames: Record<string, string> = {};

  function hasUnread(channelId: string): boolean {
    const last = reads[channelId] ?? 0;
    const top = latest[channelId] ?? 0;
    return top > last && channelId !== activeId;
  }

  async function createChannel() {
    const name = window.prompt("Channel name");
    if (!name) return;
    const isPrivate = window.confirm("Make this channel private? (OK = private, Cancel = public)");
    try {
      const { channel } = await api.createChannel({
        name: name.trim(),
        kind: isPrivate ? "private" : "public",
      });
      state.addChannel(channel);
      onSelect(channel.id);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to create channel");
    }
  }

  async function openDmPicker() {
    setShowDmPicker(true);
    if (!users) {
      try {
        const res = await api.users();
        setUsers(res.users.filter((u) => u.id !== me.id));
      } catch (e) {
        setUsersErr(e instanceof Error ? e.message : "Failed to load users");
      }
    }
  }

  async function startDm(userId: string) {
    try {
      const { channel } = await api.createDm(userId);
      state.addChannel(channel);
      setShowDmPicker(false);
      onSelect(channel.id);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to start DM");
    }
  }

  return (
    <aside className="sidebar">
      <div className="ws-head">
        <div className="ws-name">{workspace ? workspace.name : "Loose"}</div>
        {workspace && (
          <span className={`plan-badge plan-${String(workspace.plan).toLowerCase()}`}>
            {String(workspace.plan).toUpperCase()}
          </span>
        )}
        {workspace && (
          <button
            className="icon-btn ws-gear"
            title="Workspace settings"
            onClick={() => setShowAdmin(true)}
          >
            <IoSettingsOutline />
          </button>
        )}
        <span className={`conn-dot ${state.conn.status}`} title={state.conn.status} />
      </div>

      <div className="sidebar-scroll">
        <div className="section">
          <div className="section-head">
            <span>Channels</span>
            <button className="icon-btn" title="Create channel" onClick={createChannel}>
              <IoAdd />
            </button>
          </div>
          {rooms.map((c) => (
            <button
              key={c.id}
              className={`chan-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(c.id)}
            >
              <span className="chan-glyph">{c.kind === "private" ? <IoLockClosed /> : "#"}</span>
              <span className="chan-name">{c.name}</span>
              {hasUnread(c.id) && <span className="unread-dot" />}
            </button>
          ))}
          {rooms.length === 0 && <div className="empty-hint">No channels yet</div>}
        </div>

        <div className="section">
          <div className="section-head">
            <span>Direct Messages</span>
            <button className="icon-btn" title="New DM" onClick={openDmPicker}>
              <IoAdd />
            </button>
          </div>
          {dms.map((c) => (
            <button
              key={c.id}
              className={`chan-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(c.id)}
            >
              <span className="chan-name">{channelLabel(c, me, dmNames)}</span>
              {hasUnread(c.id) && <span className="unread-dot" />}
            </button>
          ))}
          {dms.length === 0 && <div className="empty-hint">No direct messages</div>}
        </div>
      </div>

      <div className="me-bar">
        <span className="presence-dot online" />
        <span className="me-name">{me.displayName}</span>
        <button className="link-btn" onClick={onLogout}>
          Log out
        </button>
      </div>

      {showAdmin && workspace && role && (
        <AdminPanel workspace={workspace} role={role} onClose={() => setShowAdmin(false)} />
      )}

      {showDmPicker && (
        <div className="modal-overlay" onClick={() => setShowDmPicker(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>Start a direct message</strong>
              <button className="icon-btn" onClick={() => setShowDmPicker(false)}>
                <IoClose />
              </button>
            </div>
            {usersErr && <div className="auth-error">{usersErr}</div>}
            {!users && !usersErr && <div className="empty-hint">Loading…</div>}
            <div className="user-list">
              {users?.map((u) => (
                <button key={u.id} className="user-row" onClick={() => startDm(u.id)}>
                  <span className={`presence-dot ${online.has(u.id) ? "online" : ""}`} />
                  <span>{u.displayName}</span>
                  {u.kind !== "human" && <span className="badge">{u.kind}</span>}
                </button>
              ))}
              {users && users.length === 0 && <div className="empty-hint">No other users</div>}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
