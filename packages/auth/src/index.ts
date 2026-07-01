import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// ── Records & repositories ───────────────────────────────────────
// The auth module owns its persistence *contracts*; the host (server store)
// supplies implementations. Swapping to Postgres or an external IdP changes
// only the wiring, never the consumers.
export interface UserRecord {
  id: string;
  workspaceId: string;
  displayName: string;
  email: string;
  kind: string; // human | bot | agent
}
export interface CredentialRecord {
  userId: string;
  type: string; // password | oauth | saml
  secretHash: string;
}
export interface SessionRecord {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface UserRepo {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(input: { workspaceId: string; displayName: string; email: string }): Promise<UserRecord>;
}
export interface CredentialRepo {
  get(userId: string): Promise<CredentialRecord | null>;
  set(cred: CredentialRecord): Promise<void>;
}
export interface SessionRepo {
  create(session: SessionRecord): Promise<void>;
  find(token: string): Promise<SessionRecord | null>;
  delete(token: string): Promise<void>;
}

// ── Public surface ───────────────────────────────────────────────
export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}
export type AuthResult =
  | { ok: true; user: UserRecord; session: Session }
  | { ok: false; error: string };

export interface ExternalProfile {
  workspaceId: string;
  email: string;
  displayName: string;
}

/** Every auth strategy implements this; app code depends only on the interface. */
export interface AuthProvider {
  register?(input: {
    email: string;
    password: string;
    displayName: string;
    workspaceId: string;
  }): Promise<AuthResult>;
  authenticate(creds: unknown): Promise<AuthResult>;
  createSession(userId: string): Promise<Session>;
  verifySession(token: string): Promise<Session | null>;
  revokeSession(token: string): Promise<void>;
  onUserProvision?(profile: ExternalProfile): Promise<UserRecord>;
}

// ── Password hashing (swappable; scrypt now, argon2id can drop in) ─
export interface Hasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

export class ScryptHasher implements Hasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const dk = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
  }
  async verify(password: string, stored: string): Promise<boolean> {
    const [scheme, saltHex, hashHex] = stored.split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const dk = (await scrypt(password, Buffer.from(saltHex, "hex"), expected.length)) as Buffer;
    return dk.length === expected.length && timingSafeEqual(dk, expected);
  }
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function asLogin(creds: unknown): { email: string; password: string } | null {
  if (typeof creds !== "object" || creds === null) return null;
  const c = creds as Record<string, unknown>;
  if (typeof c.email !== "string" || typeof c.password !== "string") return null;
  return { email: c.email, password: c.password };
}

/** DB-backed email + password. Phase 1 default. */
export class LocalAuthProvider implements AuthProvider {
  constructor(
    private users: UserRepo,
    private creds: CredentialRepo,
    private sessions: SessionRepo,
    private hasher: Hasher = new ScryptHasher(),
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    workspaceId: string;
  }): Promise<AuthResult> {
    const email = input.email.toLowerCase().trim();
    if (!email || !input.password || input.password.length < 6)
      return { ok: false, error: "email and a 6+ char password are required" };
    if (await this.users.findByEmail(email)) return { ok: false, error: "email already registered" };
    const user = await this.users.create({
      workspaceId: input.workspaceId,
      displayName: input.displayName.trim() || email.split("@")[0],
      email,
    });
    await this.creds.set({ userId: user.id, type: "password", secretHash: await this.hasher.hash(input.password) });
    return { ok: true, user, session: await this.createSession(user.id) };
  }

  async authenticate(creds: unknown): Promise<AuthResult> {
    const login = asLogin(creds);
    if (!login) return { ok: false, error: "email and password required" };
    const user = await this.users.findByEmail(login.email.toLowerCase().trim());
    if (!user) return { ok: false, error: "invalid credentials" };
    const cred = await this.creds.get(user.id);
    if (!cred || !(await this.hasher.verify(login.password, cred.secretHash)))
      return { ok: false, error: "invalid credentials" };
    return { ok: true, user, session: await this.createSession(user.id) };
  }

  async createSession(userId: string): Promise<Session> {
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const record: SessionRecord = { token, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
    await this.sessions.create(record);
    return { token, userId, expiresAt: record.expiresAt };
  }

  async verifySession(token: string): Promise<Session | null> {
    const s = await this.sessions.find(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      await this.sessions.delete(token);
      return null;
    }
    return { token: s.token, userId: s.userId, expiresAt: s.expiresAt };
  }

  async revokeSession(token: string): Promise<void> {
    await this.sessions.delete(token);
  }
}
