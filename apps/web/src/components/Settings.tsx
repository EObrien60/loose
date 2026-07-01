import { useEffect, useState } from "react";
import type { User } from "@loose/core";
import {
  IoClose,
  IoPersonOutline,
  IoLockClosedOutline,
  IoBusinessOutline,
  IoPeopleOutline,
  IoMailOutline,
  IoCardOutline,
} from "react-icons/io5";
import {
  api,
  ApiError,
  type WorkspaceInfo,
  type WorkspaceRole,
  type WorkspaceMember,
} from "../lib/api";

export type SettingsTab =
  | "profile"
  | "security"
  | "general"
  | "members"
  | "invitations"
  | "billing";

const ROLES: WorkspaceRole[] = ["owner", "admin", "member"];

const errMsg = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;

export function Settings({
  me,
  workspace,
  role,
  initialTab,
  onClose,
  onUserChange,
  onWorkspaceChange,
}: {
  me: User;
  workspace: WorkspaceInfo | null;
  role: WorkspaceRole | null;
  initialTab: SettingsTab;
  onClose: () => void;
  onUserChange: (user: User) => void;
  onWorkspaceChange: (ws: WorkspaceInfo) => void;
}) {
  const canManage = role === "owner" || role === "admin";
  const isOwner = role === "owner";
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nav: { group: string; items: { id: SettingsTab; label: string; icon: JSX.Element; show: boolean }[] }[] = [
    {
      group: "Account",
      items: [
        { id: "profile", label: "Profile", icon: <IoPersonOutline />, show: true },
        { id: "security", label: "Security", icon: <IoLockClosedOutline />, show: true },
      ],
    },
    {
      group: "Workspace",
      items: [
        { id: "general", label: "General", icon: <IoBusinessOutline />, show: !!workspace },
        { id: "members", label: "Members", icon: <IoPeopleOutline />, show: !!workspace },
        { id: "invitations", label: "Invitations", icon: <IoMailOutline />, show: !!workspace && canManage },
        { id: "billing", label: "Billing", icon: <IoCardOutline />, show: !!workspace && isOwner },
      ],
    },
  ];

  return (
    <div className="settings">
      <div className="settings-topbar">
        <span className="settings-topbar-title">Settings</span>
        <button className="icon-btn" title="Close settings (Esc)" onClick={onClose}>
          <IoClose />
        </button>
      </div>
      <div className="settings-body">
        <nav className="settings-nav">
          {nav.map((g) => {
            const items = g.items.filter((i) => i.show);
            if (items.length === 0) return null;
            return (
              <div className="settings-nav-group" key={g.group}>
                <div className="settings-nav-group-title">{g.group}</div>
                {items.map((i) => (
                  <button
                    key={i.id}
                    className={`settings-nav-item ${tab === i.id ? "active" : ""}`}
                    onClick={() => setTab(i.id)}
                  >
                    {i.icon}
                    <span>{i.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="settings-content">
          {tab === "profile" && <ProfileSection me={me} onUserChange={onUserChange} />}
          {tab === "security" && <SecuritySection />}
          {tab === "general" && workspace && (
            <GeneralSection
              workspace={workspace}
              canManage={canManage}
              onWorkspaceChange={onWorkspaceChange}
            />
          )}
          {tab === "members" && workspace && <MembersSection canManage={canManage} />}
          {tab === "invitations" && workspace && canManage && <InvitationsSection />}
          {tab === "billing" && workspace && isOwner && (
            <BillingSection workspace={workspace} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Shared building blocks so every pane has identical control sizing. */
function Panel({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="set-panel">
      <header className="set-panel-head">
        <h2>{title}</h2>
        {desc && <p>{desc}</p>}
      </header>
      {children}
    </section>
  );
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="set-field">
      <span className="set-field-label">{label}</span>
      {children}
      {hint && <span className="set-field-hint">{hint}</span>}
    </label>
  );
}
function Note({ kind, children }: { kind: "ok" | "err"; children: React.ReactNode }) {
  return <div className={`set-note set-note-${kind}`}>{children}</div>;
}

function ProfileSection({ me, onUserChange }: { me: User; onUserChange: (u: User) => void }) {
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const dirty = name.trim() !== me.displayName && name.trim().length > 0;

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const { user } = await api.updateProfile({ displayName: name.trim() });
      onUserChange(user);
      setNote({ kind: "ok", text: "Profile updated." });
    } catch (e) {
      setNote({ kind: "err", text: errMsg(e, "Failed to update profile") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Profile" desc="How you appear to everyone in the workspace.">
      <Field label="Display name">
        <input className="set-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="User ID" hint="Used by bots and the API.">
        <input className="set-input" value={me.id} readOnly />
      </Field>
      {note && <Note kind={note.kind}>{note.text}</Note>}
      <div className="set-actions">
        <button disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </Panel>
  );
}

function SecuritySection() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const mismatch = confirm.length > 0 && next !== confirm;
  const valid = cur.length > 0 && next.length >= 6 && next === confirm;

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await api.changePassword({ currentPassword: cur, newPassword: next });
      setNote({ kind: "ok", text: "Password changed." });
      setCur("");
      setNext("");
      setConfirm("");
    } catch (e) {
      setNote({ kind: "err", text: errMsg(e, "Failed to change password") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Security" desc="Change the password you use to sign in.">
      <Field label="Current password">
        <input className="set-input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} />
      </Field>
      <Field label="New password" hint="At least 6 characters.">
        <input className="set-input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Confirm new password">
        <input className="set-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      {mismatch && <Note kind="err">Passwords don’t match.</Note>}
      {note && <Note kind={note.kind}>{note.text}</Note>}
      <div className="set-actions">
        <button disabled={!valid || busy} onClick={save}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </div>
    </Panel>
  );
}

function GeneralSection({
  workspace,
  canManage,
  onWorkspaceChange,
}: {
  workspace: WorkspaceInfo;
  canManage: boolean;
  onWorkspaceChange: (ws: WorkspaceInfo) => void;
}) {
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const dirty = name.trim() !== workspace.name && name.trim().length > 0;

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const { workspace: ws } = await api.renameWorkspace(name.trim());
      onWorkspaceChange(ws);
      setNote({ kind: "ok", text: "Workspace updated." });
    } catch (e) {
      setNote({ kind: "err", text: errMsg(e, "Failed to rename workspace") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="General" desc="Basic information about this workspace.">
      <Field label="Workspace name">
        <input
          className="set-input"
          value={name}
          maxLength={60}
          disabled={!canManage}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="set-grid-2">
        <Field label="URL slug">
          <input className="set-input" value={workspace.slug} readOnly />
        </Field>
        <Field label="Plan">
          <div className="set-static">
            <span className={`plan-badge plan-${String(workspace.plan).toLowerCase()}`}>
              {workspace.plan.toUpperCase()}
            </span>
            <span className="set-static-muted">
              {workspace.memberCount} / {workspace.seatLimit} seats
            </span>
          </div>
        </Field>
      </div>
      {!canManage && <Note kind="err">Only owners and admins can rename the workspace.</Note>}
      {note && <Note kind={note.kind}>{note.text}</Note>}
      {canManage && (
        <div className="set-actions">
          <button disabled={!dirty || busy} onClick={save}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </Panel>
  );
}

function MembersSection({ canManage }: { canManage: boolean }) {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getMembers()
      .then((res) => alive && setMembers(res.members))
      .catch((e) => alive && setErr(errMsg(e, "Failed to load members")));
    return () => {
      alive = false;
    };
  }, []);

  async function changeRole(userId: string, next: WorkspaceRole) {
    setBusyUser(userId);
    setErr(null);
    const prev = members;
    setMembers((cur) => cur?.map((m) => (m.userId === userId ? { ...m, role: next } : m)) ?? cur);
    try {
      await api.setMemberRole(userId, next);
    } catch (e) {
      setMembers(prev ?? null);
      setErr(errMsg(e, "Failed to update role"));
    } finally {
      setBusyUser(null);
    }
  }

  return (
    <Panel title="Members" desc={members ? `${members.length} people in this workspace.` : "People in this workspace."}>
      {err && <Note kind="err">{err}</Note>}
      {!members && !err && <div className="empty-hint">Loading…</div>}
      {members && (
        <div className="set-list">
          {members.map((m) => (
            <div className="set-list-row" key={m.userId}>
              <div className="set-avatar">{m.displayName.slice(0, 1).toUpperCase()}</div>
              <div className="set-list-main">
                <div className="set-list-name">{m.displayName}</div>
                <div className="set-list-sub">{m.email || m.userId}</div>
              </div>
              {canManage ? (
                <select
                  className="set-select"
                  value={m.role}
                  disabled={busyUser === m.userId}
                  onChange={(e) => changeRole(m.userId, e.target.value as WorkspaceRole)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="set-role-tag">{m.role}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function InvitationsSection() {
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const res = await api.createInvite(inviteRole);
      setCode(res.code);
    } catch (e) {
      setErr(errMsg(e, "Failed to create invite"));
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <Panel title="Invitations" desc="Generate a code teammates use when they register.">
      <Field label="Invite as">
        <select
          className="set-select"
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </Field>
      {err && <Note kind="err">{err}</Note>}
      <div className="set-actions">
        <button disabled={busy} onClick={create}>
          {busy ? "Creating…" : "Create invite code"}
        </button>
      </div>
      {code && (
        <div className="set-invite">
          <code className="set-invite-code">{code}</code>
          <button className="link-btn set-invite-copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </Panel>
  );
}

function BillingSection({ workspace }: { workspace: WorkspaceInfo }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function upgrade() {
    setBusy(true);
    setNote(null);
    try {
      const res = await api.billingCheckout();
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      if (!res.configured) setNote("Billing is not configured on this server.");
    } catch (e) {
      setNote(errMsg(e, "Failed to start checkout"));
    } finally {
      setBusy(false);
    }
  }

  const pro = String(workspace.plan).toLowerCase() === "pro";
  return (
    <Panel title="Billing" desc="Manage your plan and seats.">
      <div className="set-plan-card">
        <div>
          <div className="set-plan-name">
            {workspace.plan.toUpperCase()} plan
          </div>
          <div className="set-static-muted">
            {workspace.memberCount} / {workspace.seatLimit} seats in use
          </div>
        </div>
        {!pro && (
          <button disabled={busy} onClick={upgrade}>
            {busy ? "…" : "Upgrade to Pro"}
          </button>
        )}
      </div>
      {note && <div className="empty-hint">{note}</div>}
    </Panel>
  );
}
