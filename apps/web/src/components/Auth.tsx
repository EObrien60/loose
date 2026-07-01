import { useState } from "react";
import type { User } from "@loose/core";
import { api, setToken } from "../lib/api";

type RegisterMode = "join" | "create";

export function Auth({ onAuthed }: { onAuthed: (user: User, token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [regMode, setRegMode] = useState<RegisterMode>("join");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      let res;
      if (mode === "login") {
        res = await api.login({ email, password });
      } else {
        const base = { email, password, displayName };
        if (regMode === "create") {
          res = await api.register({ ...base, workspaceName: workspaceName.trim() });
        } else {
          const code = inviteCode.trim();
          res = await api.register(code ? { ...base, inviteCode: code } : base);
        }
      }
      setToken(res.sessionToken);
      onAuthed(res.user, res.sessionToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <form className="card" onSubmit={submit}>
        <h1>Loose</h1>
        <p>{mode === "login" ? "Sign in to your workspace" : "Create an account"}</p>
        {mode === "register" && (
          <input
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        )}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {mode === "register" && (
          <>
            <div className="reg-mode">
              <button
                type="button"
                className={`reg-mode-btn ${regMode === "join" ? "active" : ""}`}
                onClick={() => setRegMode("join")}
              >
                Join your team
              </button>
              <button
                type="button"
                className={`reg-mode-btn ${regMode === "create" ? "active" : ""}`}
                onClick={() => setRegMode("create")}
              >
                Create a workspace
              </button>
            </div>
            {regMode === "join" ? (
              <input
                placeholder="Invite code (optional)"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
            ) : (
              <input
                placeholder="Workspace name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                required
              />
            )}
          </>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : mode === "login" ? "Log in" : "Register"}
        </button>
        <div className="auth-toggle">
          {mode === "login" ? "No account?" : "Already have one?"}{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setError(null);
              setMode(mode === "login" ? "register" : "login");
            }}
          >
            {mode === "login" ? "Register" : "Log in"}
          </a>
        </div>
      </form>
    </div>
  );
}
