import { useEffect, useState } from "react";
import type { User } from "@loose/core";
import { useLoose } from "./state";
import { api, type WorkspaceInfo, type WorkspaceRole } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { ChannelView } from "./components/ChannelView";
import { ThreadPanel } from "./components/ThreadPanel";

export function Workspace({
  user,
  token,
  onLogout,
}: {
  user: User;
  token: string;
  onLogout: () => void;
}) {
  const state = useLoose(token, user);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [role, setRole] = useState<WorkspaceRole | null>(null);

  // fetch workspace + role once after auth
  useEffect(() => {
    let alive = true;
    api
      .getWorkspace()
      .then((res) => {
        if (!alive) return;
        setWorkspace(res.workspace);
        setRole(res.role);
      })
      .catch(() => {
        /* non-fatal: sidebar simply omits the workspace chrome */
      });
    return () => {
      alive = false;
    };
  }, [token]);

  // auto-select first channel once channels load
  useEffect(() => {
    if (!activeId && state.channels.length > 0) {
      const first = state.channels[0];
      setActiveId(first.id);
      state.focusChannel(first.id);
    }
  }, [activeId, state]);

  function select(channelId: string) {
    setActiveId(channelId);
    setThreadRootId(null);
    state.focusChannel(channelId);
  }

  const activeChannel = state.channels.find((c) => c.id === activeId) ?? null;

  return (
    <div className="shell">
      <Sidebar
        state={state}
        activeId={activeId}
        onSelect={select}
        onLogout={onLogout}
        workspace={workspace}
        role={role}
      />
      <main className="main">
        {activeChannel ? (
          <ChannelView state={state} channel={activeChannel} onOpenThread={setThreadRootId} />
        ) : (
          <div className="empty-main">
            <div className="empty-hint">
              {state.channels.length === 0
                ? "No channels yet — create one to get started."
                : "Select a channel."}
            </div>
          </div>
        )}
      </main>
      {activeChannel && threadRootId && (
        <ThreadPanel
          state={state}
          channelId={activeChannel.id}
          rootId={threadRootId}
          onClose={() => setThreadRootId(null)}
        />
      )}
    </div>
  );
}
