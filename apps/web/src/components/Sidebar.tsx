import { IoSettingsOutline, IoAdd, IoLockClosed } from "react-icons/io5";
import type { User, Channel } from "@loose/core";
import { api, type WorkspaceInfo } from "../lib/api";
import type { LooseState } from "../state";
import type { SettingsTab } from "./Settings";

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
  onOpenSettings,
  onOpenDirectory,
}: {
  state: LooseState;
  activeId: string | null;
  onSelect: (channelId: string) => void;
  onLogout: () => void;
  workspace: WorkspaceInfo | null;
  onOpenSettings: (tab: SettingsTab) => void;
  onOpenDirectory: () => void;
}) {
  const { me, channels, reads, latest } = state;

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
            onClick={() => onOpenSettings("general")}
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
            <button className="icon-btn" title="Browse directory" onClick={onOpenDirectory}>
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
        <button
          className="me-identity"
          title="Account settings"
          onClick={() => onOpenSettings("profile")}
        >
          <span className="presence-dot online" />
          <span className="me-name">{me.displayName}</span>
        </button>
        <button className="link-btn" onClick={onLogout}>
          Log out
        </button>
      </div>
    </aside>
  );
}
