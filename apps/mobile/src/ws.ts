import type { ClientMsg, ServerMsg } from "@loose/core";

export interface Connection {
  send: (m: ClientMsg) => void;
  close: () => void;
}

/**
 * Opens a WS connection, authenticates on open, and forwards server messages.
 * Auto-reconnects with backoff; re-auths and replays a resubscribe hook on each open.
 * React Native provides a global `WebSocket`, so this mirrors the web client.
 */
export function connect(
  url: string,
  sessionToken: string,
  handlers: {
    onMessage: (m: ServerMsg) => void;
    onOpen?: () => void;
    onStatus?: (status: "connecting" | "open" | "closed") => void;
  },
): Connection {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const open = () => {
    handlers.onStatus?.("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 500;
      handlers.onStatus?.("open");
      ws?.send(JSON.stringify({ type: "auth", sessionToken } satisfies ClientMsg));
      handlers.onOpen?.();
    };
    ws.onmessage = (e: WebSocketMessageEvent) => {
      try {
        handlers.onMessage(JSON.parse(String(e.data)) as ServerMsg);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      handlers.onStatus?.("closed");
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    ws.onerror = () => {
      ws?.close();
    };
  };

  open();

  return {
    send: (m: ClientMsg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}
