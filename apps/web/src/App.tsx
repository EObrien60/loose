import { useEffect, useState } from "react";
import type { User } from "@loose/core";
import { api, getToken, clearToken } from "./lib/api";
import { identify } from "./lib/analytics";
import { Auth } from "./components/Auth";
import { Workspace } from "./Workspace";

type Session = { user: User; token: string };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);

  // restore session on load
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setRestoring(false);
      return;
    }
    api
      .me()
      .then((res) => {
        identify(res.user.id);
        setSession({ user: res.user, token });
      })
      .catch(() => {
        clearToken();
      })
      .finally(() => setRestoring(false));
  }, []);

  async function logout() {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    clearToken();
    setSession(null);
  }

  if (restoring) {
    return (
      <div className="gate">
        <div className="card">
          <h1>Loose</h1>
          <p>Restoring session…</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <Auth
        onAuthed={(user, token) => {
          identify(user.id);
          setSession({ user, token });
        }}
      />
    );
  }

  return (
    <Workspace key={session.token} user={session.user} token={session.token} onLogout={logout} />
  );
}
