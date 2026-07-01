/** Generate a client-side id for optimistic messages. */
export function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  return "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
