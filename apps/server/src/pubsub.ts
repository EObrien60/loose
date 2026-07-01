import type { ServerMsg } from "@loose/core";

type Handler = (msg: ServerMsg) => void;

/** Fan-out across connections (and, with Redis, across server instances). */
export interface PubSub {
  kind: string;
  publish(channelId: string, msg: ServerMsg): Promise<void>;
  subscribe(channelId: string, handler: Handler): () => void;
  close?(): Promise<void>;
}

class MemoryPubSub implements PubSub {
  kind = "memory";
  private subs = new Map<string, Set<Handler>>();

  async publish(channelId: string, msg: ServerMsg): Promise<void> {
    this.subs.get(channelId)?.forEach((h) => h(msg));
  }

  subscribe(channelId: string, handler: Handler): () => void {
    let set = this.subs.get(channelId);
    if (!set) {
      set = new Set();
      this.subs.set(channelId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }
}

export async function createPubSub(): Promise<PubSub> {
  const url = process.env.REDIS_URL;
  if (!url) return new MemoryPubSub();
  const { RedisPubSub } = await import("./pubsub.redis");
  return new RedisPubSub(url);
}
