import type { User } from "@loose/core";

export const HTTP_URL: string = process.env.EXPO_PUBLIC_HTTP_URL ?? "http://localhost:8787";
export const WS_URL: string = process.env.EXPO_PUBLIC_WS_URL ?? "ws://localhost:8787/ws";

/** Turn a server-relative attachment url (e.g. "/files/abc") into an absolute href. */
export function fileUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${HTTP_URL}${url}`;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
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

export interface AuthResult {
  user: User;
  sessionToken: string;
}

export const api = {
  register(body: { email: string; password: string; displayName: string }) {
    return request<AuthResult>("/auth/register", { method: "POST", body });
  },
  login(body: { email: string; password: string }) {
    return request<AuthResult>("/auth/login", { method: "POST", body });
  },
  logout(token: string) {
    return request<{ ok: true }>("/auth/logout", { method: "POST", token });
  },
};
