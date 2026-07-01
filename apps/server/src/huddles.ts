import type { HuddleParticipant } from "@loose/core";

/**
 * Per-channel huddle roster (who's in a voice/video call). The WS roster is the
 * source of truth for presence; LiveKit (when configured) carries the media.
 * In-process for the pilot — a Redis-backed version follows for multi-instance.
 */
export class Huddles {
  private byChannel = new Map<string, Map<string, HuddleParticipant>>();

  join(channelId: string, p: HuddleParticipant): void {
    let m = this.byChannel.get(channelId);
    if (!m) this.byChannel.set(channelId, (m = new Map()));
    m.set(p.userId, p);
  }

  leave(channelId: string, userId: string): void {
    const m = this.byChannel.get(channelId);
    if (!m) return;
    m.delete(userId);
    if (m.size === 0) this.byChannel.delete(channelId);
  }

  /** Remove a user from every huddle (on disconnect); returns affected channelIds. */
  leaveAll(userId: string): string[] {
    const affected: string[] = [];
    for (const [channelId, m] of this.byChannel) {
      if (m.delete(userId)) {
        affected.push(channelId);
        if (m.size === 0) this.byChannel.delete(channelId);
      }
    }
    return affected;
  }

  participants(channelId: string): HuddleParticipant[] {
    return [...(this.byChannel.get(channelId)?.values() ?? [])];
  }

  active(channelId: string): boolean {
    return (this.byChannel.get(channelId)?.size ?? 0) > 0;
  }
}
