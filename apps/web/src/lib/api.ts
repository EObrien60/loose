import type { User, Channel, Message } from "@loose/core";

export const HTTP_URL: string =
  (import.meta.env.VITE_HTTP_URL as string | undefined) ?? "http://localhost:8787";
export const WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:8787/ws";

/** Turn a server-relative attachment url (e.g. "/files/abc") into an absolute href. */
export function fileUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${HTTP_URL}${url}`;
}

const TOKEN_KEY = "loose.sessionToken";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${HTTP_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export { ApiError };

export type WorkspaceRole = "owner" | "admin" | "member";
export type WorkspacePlan = "free" | "pro" | string;

export interface AuthResult {
  user: User;
  sessionToken: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  plan: WorkspacePlan;
  seatLimit: number;
  memberCount: number;
}

export interface WorkspaceResult {
  workspace: WorkspaceInfo;
  role: WorkspaceRole;
}

export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  displayName: string;
  email: string;
}

export interface BillingCheckoutResult {
  configured: boolean;
  url?: string;
}

export interface HuddleTokenResult {
  configured: boolean;
  room: string;
  url?: string;
  token?: string;
}

export const api = {
  register(body: {
    email: string;
    password: string;
    displayName: string;
    workspaceName?: string;
    inviteCode?: string;
  }) {
    return request<AuthResult>("/auth/register", { method: "POST", body });
  },
  login(body: { email: string; password: string }) {
    return request<AuthResult>("/auth/login", { method: "POST", body });
  },
  logout() {
    return request<{ ok: true }>("/auth/logout", { method: "POST", auth: true });
  },
  me() {
    return request<{ user: User }>("/auth/me", { auth: true });
  },
  updateProfile(body: { displayName: string }) {
    return request<{ user: User }>("/auth/me", { method: "PATCH", body, auth: true });
  },
  changePassword(body: { currentPassword: string; newPassword: string }) {
    return request<{ ok: true }>("/auth/password", { method: "POST", body, auth: true });
  },
  renameWorkspace(name: string) {
    return request<WorkspaceResult>("/workspace", { method: "POST", body: { name }, auth: true });
  },
  users() {
    return request<{ users: User[] }>("/users", { auth: true });
  },
  createChannel(body: { name: string; kind: "public" | "private" }) {
    return request<{ channel: Channel }>("/channels", { method: "POST", body, auth: true });
  },
  createDm(userId: string) {
    return request<{ channel: Channel }>("/dm", { method: "POST", body: { userId }, auth: true });
  },
  search(q: string) {
    return request<{ messages: Message[] }>(`/search?q=${encodeURIComponent(q)}`, { auth: true });
  },
  getWorkspace() {
    return request<WorkspaceResult>("/workspace", { auth: true });
  },
  getMembers() {
    return request<{ members: WorkspaceMember[] }>("/workspace/members", { auth: true });
  },
  setMemberRole(userId: string, role: WorkspaceRole) {
    return request<{ ok: true }>(`/workspace/members/${encodeURIComponent(userId)}/role`, {
      method: "POST",
      body: { role },
      auth: true,
    });
  },
  createInvite(role: "member" | "admin") {
    return request<{ code: string }>("/workspace/invites", {
      method: "POST",
      body: { role },
      auth: true,
    });
  },
  billingCheckout() {
    return request<BillingCheckoutResult>("/workspace/billing/checkout", {
      method: "POST",
      auth: true,
    });
  },
  /**
   * Mint a media token for a channel's huddle. When `configured` is false the
   * server has no LiveKit creds and `url`/`token` are omitted — callers should
   * still join the WS roster but skip the media connection.
   */
  huddleToken(channelId: string) {
    return request<HuddleTokenResult>(`/huddles/${encodeURIComponent(channelId)}/token`, {
      method: "POST",
      auth: true,
    });
  },
  /**
   * Upload a file to a channel. The server broadcasts the resulting message over
   * the WS, so callers should NOT manually insert the returned message (the WS
   * dedupe path renders it). Do not set content-type — let the browser set the
   * multipart boundary.
   */
  async uploadFile(channelId: string, file: File): Promise<{ message: Message }> {
    const form = new FormData();
    form.append("file", file);
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${HTTP_URL}/channels/${encodeURIComponent(channelId)}/files`, {
      method: "POST",
      headers,
      body: form,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `Upload failed (${res.status})`;
      throw new ApiError(res.status, msg);
    }
    return data as { message: Message };
  },
};
