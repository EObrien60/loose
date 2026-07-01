import { useCallback, useEffect, useState } from "react";
import type { User } from "@loose/core";
import { useLoose } from "./state";
import { api, type WorkspaceInfo, type WorkspaceRole } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { ChannelView } from "./components/ChannelView";
import { ThreadPanel } from "./components/ThreadPanel";
import { Settings, type SettingsTab } from "./components/Settings";
import { Directory } from "./components/Directory";

export function Workspace({
  user,
  token,
  onLogout,
  onUserChange,
}: {
  user: User;
  token: string;
  onLogout: () => void;
  onUserChange: (user: User) => void;
}) {
  const state = useLoose(token, user);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  // Workspace people (humans), shared by the directory and @-mention autocomplete/rendering.
  const [people, setPeople] = useState<User[]>([]);

  const loadPeople = useCallback(() => {
    api
      .users()
      .then((res) => setPeople(res.users))
      .catch(() => {
        /* non-fatal */
      });
  }, []);

  // fetch workspace + role + people once after auth
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
    loadPeople();
    return () => {
      alive = false;
    };
  }, [token, loadPeople]);

  // auto-select first channel once channels load.
  // Depend on the specific values used (channels + the stable focusChannel callback)
  // rather than the whole `state` object, which is a fresh reference every render.
  const channels = state.channels;
  const focusChannel = state.focusChannel;
  useEffect(() => {
    if (!activeId && channels.length > 0) {
      const first = channels[0];
      setActiveId(first.id);
      focusChannel(first.id);
    }
  }, [activeId, channels, focusChannel]);

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
        onOpenSettings={(tab) => setSettingsTab(tab)}
        onOpenDirectory={() => setDirectoryOpen(true)}
      />
      <main className="main">
        {activeChannel ? (
          <ChannelView
            state={state}
            channel={activeChannel}
            people={people}
            onOpenThread={setThreadRootId}
          />
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
          people={people}
          onClose={() => setThreadRootId(null)}
        />
      )}
      {directoryOpen && (
        <Directory
          state={state}
          people={people}
          onRefresh={loadPeople}
          onStartDm={(channelId) => {
            setDirectoryOpen(false);
            select(channelId);
          }}
          onClose={() => setDirectoryOpen(false)}
        />
      )}
      {settingsTab && (
        <Settings
          me={state.me}
          workspace={workspace}
          role={role}
          initialTab={settingsTab}
          onClose={() => setSettingsTab(null)}
          onUserChange={onUserChange}
          onWorkspaceChange={setWorkspace}
        />
      )}
    </div>
  );
}
