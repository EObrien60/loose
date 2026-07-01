/**
 * Real-time media (huddle) port. Swap with MEDIA_DRIVER (default: `livekit` if LIVEKIT_* env
 * is present, else `none`). The WS roster is the source of truth for who's in a huddle; this
 * port only mints join tokens. A new provider (Daily, Twilio, Janus, …) = a class implementing
 * MediaProvider + a case in createMedia().
 */
export interface MediaToken {
  configured: boolean;
  room: string;
  url?: string;
  token?: string;
}

export interface MediaProvider {
  driver: string;
  mintToken(room: string, identity: { id: string; name: string }): Promise<MediaToken>;
}

/** No media backend — huddles still form (roster over WS), there's just no A/V transport. */
class NoneMedia implements MediaProvider {
  driver = "none";
  async mintToken(room: string): Promise<MediaToken> {
    return { configured: false, room };
  }
}

class LiveKitMedia implements MediaProvider {
  driver = "livekit";
  constructor(
    private url: string,
    private key: string,
    private secret: string,
  ) {}
  async mintToken(room: string, identity: { id: string; name: string }): Promise<MediaToken> {
    const { AccessToken } = await import("livekit-server-sdk");
    const at = new AccessToken(this.key, this.secret, { identity: identity.id, name: identity.name });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    return { configured: true, room, url: this.url, token: await at.toJwt() };
  }
}

export function createMedia(): MediaProvider {
  const driver = process.env.MEDIA_DRIVER ?? (process.env.LIVEKIT_URL ? "livekit" : "none");
  if (driver === "livekit") {
    const url = process.env.LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!url || !key || !secret) throw new Error("MEDIA_DRIVER=livekit requires LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET");
    return new LiveKitMedia(url, key, secret);
  }
  return new NoneMedia();
}
