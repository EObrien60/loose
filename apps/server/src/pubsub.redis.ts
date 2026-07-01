import Redis from "ioredis";
import type { ServerMsg } from "@loose/core";
import type { PubSub } from "./pubsub";

type Handler = (msg: ServerMsg) => void;
const PREFIX = "ch:";

/**
 * Redis-backed fan-out. Used only when REDIS_URL is set. Publishes to a per-channel
 * Redis channel; a single pattern subscriber dispatches to local connection handlers,
 * so multiple server instances stay in sync.
 */
export class RedisPubSub implements PubSub {
  kind = "redis";
  private pub: Redis;
  private sub: Redis;
  private local = new Map<string, Set<Handler>>();

  constructor(url: string) {
    this.pub = new Redis(url);
    this.sub = new Redis(url);
    this.sub.on("pmessage", (_pattern, channel, payload) => {
      const channelId = channel.slice(PREFIX.length);
      const msg = JSON.parse(payload) as ServerMsg;
      this.local.get(channelId)?.forEach((h) => h(msg));
    });
    void this.sub.psubscribe(`${PREFIX}*`);
  }

  async publish(channelId: string, msg: ServerMsg): Promise<void> {
    await this.pub.publish(`${PREFIX}${channelId}`, JSON.stringify(msg));
  }

  subscribe(channelId: string, handler: Handler): () => void {
    let set = this.local.get(channelId);
    if (!set) {
      set = new Set();
      this.local.set(channelId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }
}
