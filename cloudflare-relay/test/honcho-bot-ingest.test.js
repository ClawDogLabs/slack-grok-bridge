import { test } from "node:test";
import assert from "node:assert/strict";
import { decideIngest, materialize, sendIngest, ingestIfEnabled, botIngestSetOf, createHonchoState } from "../src/honcho.js";

const ROOM = "CPLACEHOLDER1";
const MUTED = "CPLACEHOLDER2";
const OWN_U = "UPLACEHOLDER1", OWN_B = "BPLACEHOLDER1";
const BOT_U = "UPLACEHOLDER2", BOT_B = "BPLACEHOLDER2";
const STRANGER_U = "UPLACEHOLDER3", STRANGER_B = "BPLACEHOLDER3";
const HUMAN = "UPLACEHOLDER4";
const botIds = botIngestSetOf({ HONCHO_BOT_INGEST_IDS: `${BOT_U}, ${BOT_B}` });
const base = (extra = {}) => ({ type: "message", channel: ROOM, channel_type: "channel", ts: "1000.1", text: "here is my answer", ...extra });
const opts = { ownUserId: OWN_U, ownBotId: OWN_B, botIds };

test("registry parsing", () => {
  assert.equal(botIngestSetOf({}).size, 0);
  assert.deepEqual([...botIds], [BOT_U, BOT_B]);
});

test("allowlisted bot reply is ingested as its own peer, labeled bot", async () => {
  const d = decideIngest(base({ user: BOT_U, bot_id: BOT_B }), opts);
  assert.equal(d.ok, true);
  assert.equal(d.peerId, BOT_U);
  assert.equal(d.authorKind, "bot");
  const p = await materialize(d, { displayName: "HelperBot" });
  assert.equal(p.metadata.author_kind, "bot");
  assert.equal(p.metadata.bot_id, BOT_B);
  assert.equal(p.content, "HelperBot: here is my answer");
});

test("match by bot id alone; bot_message without user uses bot id as peer", () => {
  const d = decideIngest(base({ subtype: "bot_message", bot_id: BOT_B }), { ...opts, botIds: new Set([BOT_B]) });
  assert.equal(d.ok, true);
  assert.equal(d.peerId, BOT_B);
});

test("own replies are labeled bot too", () => {
  const d = decideIngest(base({ user: OWN_U, bot_id: OWN_B }), opts);
  assert.equal(d.ok, true);
  assert.equal(d.authorKind, "bot");
});

test("non-allowlisted bots still skipped; empty registry keeps old behavior", () => {
  assert.equal(decideIngest(base({ user: STRANGER_U, bot_id: STRANGER_B }), opts).reason, "bot");
  assert.equal(decideIngest(base({ user: BOT_U, bot_id: BOT_B }), { ownUserId: OWN_U, ownBotId: OWN_B }).reason, "bot");
});

test("humans unchanged (no bot label)", async () => {
  const d = decideIngest(base({ user: HUMAN }), opts);
  assert.equal(d.ok, true);
  assert.equal(d.authorKind, null);
  const p = await materialize(d, {});
  assert.equal(p.metadata.author_kind, undefined);
});

test("DMs, group DMs and private non-opted channels fail closed for bots", () => {
  for (const ct of ["im", "mpim", "group"]) {
    assert.equal(decideIngest(base({ user: BOT_U, bot_id: BOT_B, channel_type: ct }), opts).ok, false);
  }
});

test("edits, deletes and system subtypes skipped for bots", () => {
  for (const st of ["message_changed", "message_deleted", "channel_join", "channel_topic"]) {
    assert.equal(decideIngest(base({ user: BOT_U, bot_id: BOT_B, subtype: st }), opts).reason, "subtype");
  }
});

test("privacy filters still apply to bot text", () => {
  const d = decideIngest(base({ user: BOT_U, bot_id: BOT_B, text: "token xoxb-1234567890-abcdefghij" }), opts);
  assert.equal(d.ok, false);
});

test("sendIngest creates bot peer with kind metadata", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response("{}"); };
  const d = decideIngest(base({ user: BOT_U, bot_id: BOT_B }), opts);
  await sendIngest({ HONCHO_API_KEY: "k", HONCHO_WORKSPACE_ID: "ws-test" }, await materialize(d, {}), { fetchImpl, state: createHonchoState() });
  const peer = calls.find((c) => c.url.endsWith("/peers") && c.body.id === BOT_U);
  assert.deepEqual(peer.body.metadata, { kind: "bot", source: "slack" });
  const msg = calls.find((c) => c.url.endsWith("/messages"));
  assert.equal(msg.body.messages[0].peer_id, BOT_U);
  assert.equal(msg.body.messages[0].metadata.author_kind, "bot");
});

function liveEnv(extra = {}) {
  return { HONCHO_INGEST: "1", HONCHO_API_KEY: "k", HONCHO_WORKSPACE_ID: "ws-test", HONCHO_CHANNEL_IDS: ROOM,
    HONCHO_BOT_INGEST_IDS: BOT_U, SILENT_CHANNEL_IDS: MUTED, ...extra };
}

test("live path: registry from env, dedupe by ts, muted channel never", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response("{}"); };
  const state = createHonchoState();
  const o = { ownUserId: OWN_U, ownBotId: OWN_B, fetchImpl, state, log: () => {} };
  const e = base({ user: BOT_U, bot_id: BOT_B, ts: "2000.5" });
  await ingestIfEnabled(liveEnv(), e, o);
  await ingestIfEnabled(liveEnv(), e, o);
  assert.equal(calls.filter((c) => c.url.endsWith("/messages")).length, 1);
  const r = ingestIfEnabled(liveEnv(), base({ user: BOT_U, bot_id: BOT_B, channel: MUTED, ts: "2000.6" }), o);
  if (r) await r;
  assert.equal(calls.filter((c) => c.url.endsWith("/messages")).length, 1);
  const r2 = ingestIfEnabled(liveEnv({ HONCHO_BOT_INGEST_IDS: "" }), base({ user: BOT_U, bot_id: BOT_B, ts: "2000.7" }), o);
  if (r2) await r2;
  assert.equal(calls.filter((c) => c.url.endsWith("/messages")).length, 1);
});
