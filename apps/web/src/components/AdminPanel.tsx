import { useEffect, useState } from "react";
import {
  api,
  type WorkspaceInfo,
  type WorkspaceRole,
  type WorkspaceMember,
} from "../lib/api";

const ROLES: WorkspaceRole[] = ["owner", "admin", "member"];

export function AdminPanel({
  workspace,
  role,
  onClose,
}: {
  workspace: WorkspaceInfo;
  role: WorkspaceRole;
  onClose: () => void;
}) {
  const canManage = role === "owner" || role === "admin";
  const isOwner = role === "owner";

  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [membersErr, setMembersErr] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const [billingNote, setBillingNote] = useState<string | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);

  // memberCount can drift from the loaded list once roles/invites change;
  // prefer the live list length when we have it.
  const memberCount = members ? members.length : workspace.memberCount;

  useEffect(() => {
    let alive = true;
    api
      .getMembers()
      .then((res) => {
        if (alive) setMembers(res.members);
      })
      .catch((e) => {
        if (alive) setMembersErr(e instanceof Error ? e.message : "Failed to load members");
      });
    return () => {
      alive = false;
    };
  }, []);

  async function changeRole(userId: string, next: WorkspaceRole) {
    setBusyUser(userId);
    setMembersErr(null);
    const prev = members;
    // optimistic
    setMembers((cur) =>
      cur ? cur.map((m) => (m.userId === userId ? { ...m, role: next } : m)) : cur,
    );
    try {
      await api.setMemberRole(userId, next);
    } catch (e) {
      setMembers(prev ?? null);
      setMembersErr(e instanceof Error ? e.message : "Failed to update role");
    } finally {
      setBusyUser(null);
    }
  }

  async function invite() {
    setInviteBusy(true);
    setInviteErr(null);
    setCopied(false);
    try {
      const { code } = await api.createInvite(inviteRole);
      setInviteCode(code);
    } catch (e) {
      setInviteErr(e instanceof Error ? e.message : "Failed to create invite");
    } finally {
      setInviteBusy(false);
    }
  }

  async function copyCode() {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function upgrade() {
    setBillingBusy(true);
    setBillingNote(null);
    try {
      const res = await api.billingCheckout();
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      if (!res.configured) {
        setBillingNote("Billing is not configured on this server.");
      }
    } catch (e) {
      setBillingNote(e instanceof Error ? e.message : "Failed to start checkout");
    } finally {
      setBillingBusy(false);
    }
  }

  const planLabel = workspace.plan.toUpperCase();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Workspace settings</strong>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="admin-body">
          {/* Overview */}
          <section className="admin-section">
            <div className="admin-ws-head">
              <span className="admin-ws-name">{workspace.name}</span>
              <span className={`plan-badge plan-${String(workspace.plan).toLowerCase()}`}>
                {planLabel}
              </span>
            </div>
            <div className="admin-seats">
              Seats: {memberCount} / {workspace.seatLimit}
            </div>
          </section>

          {/* Members */}
          <section className="admin-section">
            <div className="admin-section-title">Members</div>
            {membersErr && <div className="auth-error">{membersErr}</div>}
            {!members && !membersErr && <div className="empty-hint">Loading…</div>}
            {members && (
              <table className="members-table">
                <tbody>
                  {members.map((m) => (
                    <tr key={m.userId}>
                      <td className="member-id">
                        <div className="member-name">{m.displayName}</div>
                        <div className="member-email">{m.email}</div>
                      </td>
                      <td className="member-role">
                        {canManage ? (
                          <select
                            className="role-select"
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
                          <span className="role-readonly">{m.role}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Invite */}
          {canManage && (
            <section className="admin-section">
              <div className="admin-section-title">Invite people</div>
              <div className="invite-row">
                <select
                  className="role-select"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
                <button onClick={invite} disabled={inviteBusy}>
                  {inviteBusy ? "…" : "Create invite"}
                </button>
              </div>
              {inviteErr && <div className="auth-error">{inviteErr}</div>}
              {inviteCode && (
                <>
                  <div className="invite-code-row">
                    <code className="invite-code">{inviteCode}</code>
                    <button className="invite-copy" onClick={copyCode}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <div className="empty-hint">
                    Teammates register with this code to join as {inviteRole}.
                  </div>
                </>
              )}
            </section>
          )}

          {/* Billing */}
          {isOwner && (
            <section className="admin-section">
              <div className="admin-section-title">Billing</div>
              <div className="admin-seats">
                Current plan: <strong>{planLabel}</strong>
              </div>
              <button className="upgrade-btn" onClick={upgrade} disabled={billingBusy}>
                {billingBusy ? "…" : "Upgrade to Pro"}
              </button>
              {billingNote && <div className="empty-hint">{billingNote}</div>}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
