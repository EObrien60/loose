import { post, get, register, wsClient, sleep, HTTP, WS } from "./lib.mjs";

// ── core chat: auth, channels, fan-out, threads, reactions, files, connectors, MCP, search, DM ──
export async function chatSuite(rec, seed) {
  rec.section("chat: auth + workspace");
  const a = await register(`alice-${seed}@x.io`, { displayName: "Alice" });
  const b = await register(`bob-${seed}@x.io`, { displayName: "Bob" });
  rec.check("register alice", a.status === 200 && !!a.json.sessionToken, JSON.stringify(a.json));
  rec.check("duplicate email rejected", (await register(`alice-${seed}@x.io`)).status === 400);
  rec.check("bad password rejected", (await post("/auth/login", { email: `alice-${seed}@x.io`, password: "nope" })).status === 401);
  const aTok = a.json.sessionToken, bTok = b.json.sessionToken, aId = a.json.user.id, bId = b.json.user.id;

  const ca = wsClient(aTok);
  const ack = await ca.waitFor((m) => m.type === "auth.ok");
  const general = ack.channels.find((c) => c.name === "general");
  rec.check("auth.ok + seeded channels", !!general && ack.channels.length >= 6);
  const cb = wsClient(bTok);
  await cb.waitFor((m) => m.type === "auth.ok");
  rec.check("presence: alice sees bob online", !!(await ca.waitFor((m) => m.type === "presence.changed" && m.online.includes(bId)).catch(() => null)));

  rec.section("chat: messages, threads, reactions");
  ca.send({ type: "channel.subscribe", channelId: general.id });
  await ca.waitFor((m) => m.type === "channel.history" && m.channelId === general.id);
  ca.send({ type: "message.send", channelId: general.id, clientId: "c1", body: "hello team" });
  const self = await ca.waitFor((m) => m.type === "message.new" && m.clientId === "c1");
  rec.check("sender echo w/ clientId", !!self);
  rec.check("fan-out to bob", !!(await cb.waitFor((m) => m.type === "message.new" && m.message.body === "hello team")));
  const rootId = self.message.id;
  ca.send({ type: "message.send", channelId: general.id, clientId: "c2", body: "reply", threadRootId: rootId });
  await ca.waitFor((m) => m.type === "message.new" && m.message.threadRootId === rootId);
  ca.send({ type: "channel.subscribe", channelId: general.id });
  const hist = await ca.waitFor((m) => m.type === "channel.history" && m.messages.some((x) => x.id === rootId));
  rec.check("thread reply increments replyCount", hist.messages.find((x) => x.id === rootId)?.replyCount === 1);
  ca.send({ type: "reaction.add", channelId: general.id, messageId: rootId, emoji: "🎉" });
  rec.check("reaction fans out", !!(await cb.waitFor((m) => m.type === "reaction.changed" && m.reaction.userIds.includes(aId))));

  rec.section("chat: files (exercises storage driver)");
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("hello file " + seed)], { type: "text/plain" }), "note.txt");
  const up = await fetch(HTTP + "/channels/" + general.id + "/files", { method: "POST", headers: { authorization: `Bearer ${aTok}` }, body: fd });
  const upJson = await up.json();
  const att = upJson.message?.attachments?.[0];
  rec.check("file upload -> attachment", !!att?.url, JSON.stringify(upJson));
  const dl = await fetch(att.url.startsWith("http") ? att.url : HTTP + att.url);
  rec.check("uploaded file served back", (await dl.text()) === "hello file " + seed);

  rec.section("chat: connector webhook + bot/MCP + search");
  const ciCh = ack.channels.find((c) => c.name === "ci");
  await post("/webhooks/ci/secret", { pipeline: "build", status: "failed", url: "https://ci/1" });
  const card = await cb.waitFor((m) => m.type === "message.new" && m.message.channelId === ciCh.id, 3000).catch(() => null);
  rec.check("CI webhook -> system card", card?.message.kind === "system" && Array.isArray(card.message.blocks));
  const bot = await post("/bots", { name: "ci-bot" }, aTok);
  rec.check("bot created", !!bot.json.token);
  const tools = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, bot.json.token);
  rec.check("MCP tools/list (4)", tools.json.result?.tools?.length === 4);
  const body = `mcp-${seed}`;
  await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "post_message", arguments: { channelId: general.id, body } } }, bot.json.token);
  rec.check("MCP post fans out (agent)", !!(await ca.waitFor((m) => m.type === "message.new" && m.message.body === body && m.message.kind === "agent")));
  rec.check("MCP rejects no token", (await post("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/list" })).status === 401);
  rec.check("search finds message", (await get("/search?q=" + encodeURIComponent(body), aTok)).json.messages?.some((m) => m.body === body));

  rec.section("chat: agent-run streaming (LLM port)");
  ca.send({ type: "agent.invoke", channelId: general.id, prompt: "summarize" });
  rec.check("agent.run.delta streamed", !!(await ca.waitFor((m) => m.type === "agent.run.delta", 4000).catch(() => null)));
  const done = await ca.waitFor((m) => m.type === "agent.run.done", 6000).catch(() => null);
  rec.check("agent.run.done + final agent message", !!done && ca.inbox.some((m) => m.type === "message.new" && m.message.id === done.messageId && m.message.kind === "agent"));

  rec.section("chat: DM");
  const dm = await post("/dm", { userId: bId }, aTok);
  rec.check("DM created with members", dm.json.channel?.kind === "dm" && dm.json.channel.members?.includes(bId));

  await sleep(50);
  ca.ws.close();
  cb.ws.close();
}

// ── collab: huddles (media port) + Slack bridge ──
export async function collabSuite(rec, seed) {
  const drivers = (await get("/")).json.drivers ?? {};
  const a = await register(`hud-${seed}@x.io`);
  const b = await register(`hud2-${seed}@x.io`);
  const aTok = a.json.sessionToken, aId = a.json.user.id;
  const ca = wsClient(aTok);
  const ack = await ca.waitFor((m) => m.type === "auth.ok");
  const general = ack.channels.find((c) => c.name === "general");
  const cb = wsClient(b.json.sessionToken);
  await cb.waitFor((m) => m.type === "auth.ok");

  rec.section(`collab: huddle token (media=${drivers.media})`);
  const tok = await post(`/huddles/${general.id}/token`, {}, aTok);
  if (drivers.media === "livekit") {
    rec.check("LiveKit JWT minted", (tok.json.token ?? "").split(".").length === 3 && !!tok.json.url);
    rec.check("room name correct", tok.json.room === `loose-${general.id}`);
  } else {
    rec.check("media not-configured reported with room", tok.json.configured === false && !!tok.json.room);
  }

  rec.section("collab: huddle roster fan-out");
  ca.send({ type: "huddle.join", channelId: general.id });
  rec.check("Ada joins -> huddle.state active", !!(await ca.waitFor((m) => m.type === "huddle.state" && m.active && m.participants.some((p) => p.userId === aId))));
  rec.check("Ben sees Ada (fan-out)", !!(await cb.waitFor((m) => m.type === "huddle.state" && m.participants.some((p) => p.userId === aId))));
  ca.send({ type: "huddle.leave", channelId: general.id });
  rec.check("leave updates roster", !!(await cb.waitFor((m) => m.type === "huddle.state" && !m.participants.some((p) => p.userId === aId))));

  rec.section("collab: Slack bridge (inbound)");
  rec.check("url_verification echoes challenge", (await post("/slack/events", { type: "url_verification", challenge: "x" })).json.challenge === "x");
  const body = `slack-${seed}`;
  await post("/slack/events", { type: "event_callback", event: { type: "message", channel: "C1", user: "U9", user_name: "slacker", text: body, ts: "1700000000.0001" } });
  await sleep(120);
  rec.check("inbound Slack message ingested + searchable", (await get("/search?q=" + encodeURIComponent(body), aTok)).json.messages?.some((m) => m.body === body));

  await sleep(50);
  ca.ws.close();
  cb.ws.close();
}

// ── tenancy: workspaces, isolation, roles, invites, seats, billing, SCIM, rate limit ──
// Owner/admin/billing actions run on a workspace this suite creates (so the caller is a real
// owner) — w_main may already be populated by earlier suites.
export async function tenancySuite(rec, seed) {
  rec.section("tenancy: workspaces + roles");
  const plain = await register(`plain-${seed}@x.io`);
  rec.check("default registrant lands in w_main", plain.json.workspaceId === "w_main");
  const org = await register(`orgowner-${seed}@x.io`, { workspaceName: "Org " + seed });
  rec.check("named workspace -> owner", org.json.role === "owner");
  const orgTok = org.json.sessionToken;
  const orgWsId = org.json.workspaceId;
  const wsInfo = await get("/workspace", orgTok);
  rec.check("GET /workspace (owner, plan=free)", wsInfo.json.role === "owner" && wsInfo.json.workspace?.plan === "free");

  rec.section("tenancy: isolation");
  const cp = wsClient(plain.json.sessionToken);
  const ackP = await cp.waitFor((m) => m.type === "auth.ok");
  const defGeneral = ackP.channels.find((c) => c.name === "general");
  const co = wsClient(orgTok);
  const ackO = await co.waitFor((m) => m.type === "auth.ok");
  rec.check("new workspace isolated (2 channels, no overlap)", ackO.channels.length === 2 && !ackO.channels.some((c) => c.id === defGeneral.id));
  co.send({ type: "channel.subscribe", channelId: defGeneral.id });
  rec.check("cross-workspace subscribe denied", !!(await co.waitFor((m) => m.type === "error")));

  rec.section("tenancy: invites + roles (on Org)");
  rec.check("non-member/member cannot invite (403)", (await post("/workspace/invites", { role: "member" }, plain.json.sessionToken)).status === 403);
  const invite = await post("/workspace/invites", { role: "member" }, orgTok);
  rec.check("owner creates invite", !!invite.json.code);
  const joined = await register(`orgmem-${seed}@x.io`, { inviteCode: invite.json.code });
  rec.check("join via invite -> member of Org", joined.json.workspaceId === orgWsId && joined.json.role === "member");
  rec.check("owner promotes member -> admin", (await post(`/workspace/members/${joined.json.user.id}/role`, { role: "admin" }, orgTok)).json.ok === true);
  rec.check("members list reflects role", (await get("/workspace/members", orgTok)).json.members?.find((m) => m.userId === joined.json.user.id)?.role === "admin");

  rec.section("tenancy: seat limit (WORKSPACE_SEAT_LIMIT=3; Org has owner+1)");
  const j3 = await register(`seat3-${seed}@x.io`, { inviteCode: invite.json.code }); // 3rd member == limit
  rec.check("join up to seat limit succeeds", j3.status === 200);
  rec.check("join beyond seat limit -> 403", (await register(`seat4-${seed}@x.io`, { inviteCode: invite.json.code })).status === 403);

  rec.section("tenancy: billing + SCIM");
  rec.check("checkout not-configured (no Stripe)", (await post("/workspace/billing/checkout", {}, orgTok)).json.configured === false);
  await post("/stripe/webhook", { type: "checkout.session.completed", data: { object: { client_reference_id: orgWsId } } });
  await sleep(80);
  const up = await get("/workspace", orgTok);
  rec.check("webhook upgraded Org -> pro/200", up.json.workspace?.plan === "pro" && up.json.workspace?.seatLimit === 200);
  rec.check("SCIM rejects no token (401)", (await post("/scim/v2/Users", { userName: `n-${seed}@x.io` })).status === 401);
  const scim = await fetch(HTTP + "/scim/v2/Users", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer scim-secret" }, body: JSON.stringify({ userName: `scim-${seed}@x.io`, displayName: "SCIM" }) });
  rec.check("SCIM provisions user (201)", scim.status === 201 && !!(await scim.json()).id);

  rec.section("tenancy: rate limiting");
  let got429 = false;
  for (let i = 0; i < 45 && !got429; i++) {
    const r = await fetch(HTTP + "/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `rl-${seed}-${i}@x.io`, password: "secret1", displayName: "RL" }) });
    if (r.status === 429) got429 = true;
  }
  rec.check("register flood -> 429", got429);

  await sleep(50);
  cp.ws.close();
  co.ws.close();
}

// ── journeys: edit/delete, live channels, pagination, authz, reconnect, unauth timeout ──
export async function journeysSuite(rec, seed) {
  const a = await register(`ja-${seed}@x.io`, { displayName: "Ada" });
  const b = await register(`jb-${seed}@x.io`, { displayName: "Ben" });
  const aTok = a.json.sessionToken, bTok = b.json.sessionToken, bId = b.json.user.id;
  const ca = wsClient(aTok);
  const ack = await ca.waitFor((m) => m.type === "auth.ok");
  const general = ack.channels.find((c) => c.name === "general");
  const cb = wsClient(bTok);
  await cb.waitFor((m) => m.type === "auth.ok");
  ca.send({ type: "channel.subscribe", channelId: general.id });
  await ca.waitFor((m) => m.type === "channel.history" && m.channelId === general.id);
  cb.send({ type: "channel.subscribe", channelId: general.id });
  await cb.waitFor((m) => m.type === "channel.history" && m.channelId === general.id);

  rec.section("journey: edit & delete a message");
  ca.send({ type: "message.send", channelId: general.id, clientId: "e1", body: "orig" });
  const sent = await ca.waitFor((m) => m.type === "message.new" && m.clientId === "e1");
  const mid = sent.message.id;
  ca.send({ type: "message.edit", channelId: general.id, messageId: mid, body: "edited!" });
  const edit = await cb.waitFor((m) => m.type === "message.updated" && m.message.id === mid);
  rec.check("edit broadcasts message.updated (body + editedAt)", edit.message.body === "edited!" && !!edit.message.editedAt);
  ca.send({ type: "message.delete", channelId: general.id, messageId: mid });
  const del = await cb.waitFor((m) => m.type === "message.updated" && m.message.id === mid && m.message.deletedAt);
  rec.check("delete broadcasts tombstone (deletedAt, empty body)", !!del.message.deletedAt && del.message.body === "");

  rec.section("journey: author-only edit/delete (authz)");
  ca.send({ type: "message.send", channelId: general.id, clientId: "e2", body: "ada's msg" });
  const adaMsg = (await ca.waitFor((m) => m.type === "message.new" && m.clientId === "e2")).message.id;
  cb.send({ type: "message.edit", channelId: general.id, messageId: adaMsg, body: "hacked" });
  rec.check("non-author edit is rejected", !!(await cb.waitFor((m) => m.type === "error").catch(() => null)));
  const leaked = await ca.waitFor((m) => m.type === "message.updated" && m.message.id === adaMsg && m.message.body === "hacked", 800).catch(() => null);
  rec.check("non-author edit does not mutate message", leaked === null);

  rec.section("journey: live channel + DM creation");
  const created = await post("/channels", { name: `proj-${seed}`, kind: "public" }, aTok);
  rec.check("new public channel announced to connected member", !!(await cb.waitFor((m) => m.type === "channel.created" && m.channel.id === created.json.channel.id, 3000).catch(() => null)));
  const dm = await post("/dm", { userId: bId }, aTok);
  rec.check("new DM announced to recipient", !!(await cb.waitFor((m) => m.type === "channel.created" && m.channel.id === dm.json.channel.id, 3000).catch(() => null)));

  rec.section("journey: history pagination (load older)");
  const big = await post("/channels", { name: `big-${seed}`, kind: "public" }, aTok);
  const bigId = big.json.channel.id;
  ca.send({ type: "channel.subscribe", channelId: bigId });
  await ca.waitFor((m) => m.type === "channel.history" && m.channelId === bigId);
  for (let i = 0; i < 105; i++) {
    ca.send({ type: "message.send", channelId: bigId, clientId: `p${i}`, body: `m${i}` });
    await sleep(2); // distinct createdAt for stable ordering
  }
  await ca.waitFor((m) => m.type === "message.new" && m.clientId === "p104");
  ca.send({ type: "channel.subscribe", channelId: bigId });
  const page1 = await ca.waitFor((m) => m.type === "channel.history" && m.channelId === bigId && m.messages.length >= 100);
  rec.check("initial history caps at 100", page1.messages.length === 100);
  const oldest = page1.messages[0].createdAt;
  const loaded = new Set(page1.messages.map((m) => m.id));
  ca.send({ type: "channel.more", channelId: bigId, before: oldest });
  const older = await ca.waitFor((m) => m.type === "channel.page" && m.channelId === bigId);
  rec.check("channel.more returns older, disjoint messages", older.messages.length > 0 && older.messages.every((m) => !loaded.has(m.id) && m.createdAt <= oldest));
  rec.check("pagination reports hasMore=false at start", older.hasMore === false);

  rec.section("journey: reaction authz across channels");
  const priv = await post("/channels", { name: `secret-${seed}`, kind: "private" }, aTok); // Ada-only
  const privId = priv.json.channel.id;
  ca.send({ type: "channel.subscribe", channelId: privId });
  await ca.waitFor((m) => m.type === "channel.history" && m.channelId === privId);
  ca.send({ type: "message.send", channelId: privId, clientId: "s1", body: "secret" });
  const secretMid = (await ca.waitFor((m) => m.type === "message.new" && m.clientId === "s1")).message.id;
  // Ben reacts to the private message via a channel he CAN access — must be ignored.
  cb.send({ type: "reaction.add", channelId: general.id, messageId: secretMid, emoji: "👀" });
  const sneaked = await ca.waitFor((m) => m.type === "reaction.changed" && m.reaction.messageId === secretMid, 800).catch(() => null);
  rec.check("cross-channel reaction is blocked", sneaked === null);

  rec.section("journey: reconnect restores history");
  ca.send({ type: "message.send", channelId: general.id, clientId: "r1", body: `persist-${seed}` });
  await ca.waitFor((m) => m.type === "message.new" && m.clientId === "r1");
  const ca2 = wsClient(aTok); // fresh connection (simulated reconnect)
  await ca2.waitFor((m) => m.type === "auth.ok");
  ca2.send({ type: "channel.subscribe", channelId: general.id });
  const restored = await ca2.waitFor((m) => m.type === "channel.history" && m.channelId === general.id);
  rec.check("reconnect + subscribe restores history", restored.messages.some((m) => m.body === `persist-${seed}`));
  ca2.ws.close();

  rec.section("journey: unauthenticated socket is dropped");
  const closed = await new Promise((resolve) => {
    const raw = new WebSocket(WS); // never sends auth
    raw.onclose = () => resolve(true);
    setTimeout(() => resolve(false), 4000);
  });
  rec.check("idle unauthenticated socket times out", closed === true);

  await sleep(50);
  ca.ws.close();
  cb.ws.close();
}

// ── providers: assert the active driver matrix + readiness ──
export async function providersSuite(rec, expected) {
  rec.section("providers: driver matrix + health");
  const root = (await get("/")).json;
  const drivers = root.drivers ?? {};
  for (const [port, want] of Object.entries(expected)) {
    rec.check(`driver ${port}=${want}`, drivers[port] === want, `got ${drivers[port]}`);
  }
  rec.check("/readyz ready", (await get("/readyz")).json.ready === true);
  rec.check("/healthz ok", (await get("/healthz")).json.ok === true);
}
