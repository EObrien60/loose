/**
 * Workspace presence. Counts live connections per user so multiple tabs/devices
 * collapse to a single "online" state. In-process for the single-instance pilot;
 * a Redis-set-backed version follows when we scale out (see BUILD_PLAN §13).
 */
export class Presence {
  private counts = new Map<string, Map<string, number>>(); // workspaceId -> userId -> connCount

  private ws(workspaceId: string): Map<string, number> {
    let m = this.counts.get(workspaceId);
    if (!m) {
      m = new Map();
      this.counts.set(workspaceId, m);
    }
    return m;
  }

  /** @returns true if this user just transitioned offline -> online. */
  add(workspaceId: string, userId: string): boolean {
    const m = this.ws(workspaceId);
    const next = (m.get(userId) ?? 0) + 1;
    m.set(userId, next);
    return next === 1;
  }

  /** @returns true if this user just transitioned online -> offline. */
  remove(workspaceId: string, userId: string): boolean {
    const m = this.ws(workspaceId);
    const next = (m.get(userId) ?? 0) - 1;
    if (next <= 0) {
      m.delete(userId);
      return true;
    }
    m.set(userId, next);
    return false;
  }

  online(workspaceId: string): string[] {
    return [...this.ws(workspaceId).keys()];
  }
}
