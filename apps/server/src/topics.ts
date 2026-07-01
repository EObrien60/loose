// PubSub topic conventions. Connections subscribe to their workspace + user topics at auth,
// so server-side events (presence, new channels, DMs) can be routed without a channel sub.
export const workspaceTopic = (workspaceId: string) => `wsr:${workspaceId}`;
export const userTopic = (userId: string) => `usr:${userId}`;
