import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { stickyEnabled, stickyOp, slackSignature, noteOwnRootPost } from "../src/index.js";

const BOT = "UPLACEHOLDER6";
const c = { ownUserId: BOT, ownBotId: "BPLACEHOLDER5" };
const kv = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
};
const baseEnv = (store, extra = {}) => ({
  SLACK_SIGNING_SECRET: "sec", SLACK_BOT_TOKEN: "t", GROK_WEBHOOK_URL: "https://grok.test/hook",
  OWN_USER_ID: BOT, OWN_BOT_ID: "BPLACEHOLDER5", BRIDGE_SOURCE: "slack-bot-bridge",
  PRIVROOM_STATE: store, HONCHO_READ: "0", HONCHO_INGEST: "0", ...extra,
});
let wakes = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://grok.test")) { wakes.push(JSON.parse(init.body)); return new Response("ok"); }
  return new Response(JSON.stringify({ ok: true, user: { name: "h", profile: {} }, messages: [] }));
};
async function send(env, event) {
  const raw = JSON.stringify({ type: "event_callback", event_id: "Ev" + Math.random(), event });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await slackSignature("sec", ts, raw);
  const tasks = [];
  await worker.fetch(new Request("https://relay.test/slack/events", {
    method: "POST", body: raw, headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
  }), env, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
}
const CH = "CPLACEHOLDER4";
const mention = { type: "app_mention", channel: CH, user: "UHUMAN", ts: "100.1", text: `<@${BOT}> help` };
const reply = (text, extra = {}) => ({ type: "message", channel: CH, channel_type: "channel", user: "UHUMAN", ts: "100.5", thread_ts: "100.1", text, ...extra });

test("stickyEnabled kill switch", () => {
  assert.equal(stickyEnabled({}), true);
  for (const v of ["0", "false", "off", "OFF"]) assert.equal(stickyEnabled({ STICKY_THREADS: v }), false);
});

test("stickyOp decisions", () => {
  assert.equal(stickyOp(mention, c).op, "set");
  assert.equal(stickyOp({ ...mention, text: `<@${BOT}> <@UPLACEHOLDER2>` }, c).op, null);
  assert.equal(stickyOp(reply("<@UPLACEHOLDER2> hi"), c).otherTag, true);
  assert.equal(stickyOp(reply("more please"), c).op, "check");
  assert.equal(stickyOp(reply("x", { bot_id: "B1" }), c).op, null);
  assert.equal(stickyOp(reply("x", { subtype: "message_changed" }), c).op, null);
  assert.equal(stickyOp(reply("x", { subtype: "channel_join" }), c).op, null);
  assert.equal(stickyOp(reply("x", { user: BOT }), c).op, null);
  assert.equal(stickyOp(reply("x", { thread_ts: undefined }), c).op, null);
  const root = { type: "message", channel: CH, channel_type: "channel", user: BOT, bot_id: "BPLACEHOLDER5", subtype: "bot_message", ts: "300.1", text: "started" };
  assert.equal(stickyOp(root, c).op, "claim");
  assert.equal(stickyOp(root, c).root, "300.1");
  assert.equal(stickyOp({ ...root, channel_type: "group" }, c).op, "claim");
  assert.equal(stickyOp({ ...root, user: undefined }, c).op, "claim");
  assert.equal(stickyOp({ ...root, thread_ts: "200.1", ts: "300.1" }, c).op, null);
  assert.equal(stickyOp({ ...root, user: "UOTHER", bot_id: "BOTHER" }, c).op, null);
  assert.equal(stickyOp({ ...root, subtype: "message_changed" }, c).op, null);
  assert.equal(stickyOp({ ...root, type: "app_mention", text: "started" }, c).op, null);
});

test("sticky set then untagged follow-up wakes once with sticky:true", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, mention);
  assert.ok(s.m.has(`sticky:${CH}:100.1`));
  const mentionWakes = wakes.length; // the app_mention itself wakes normally
  assert.equal(mentionWakes, 1);
  await send(env, reply("and what about blue?"));
  assert.equal(wakes.length, 2);
  assert.equal(wakes[1].kind, "app_mention");
  assert.equal(wakes[1].sticky, true);
  assert.equal(wakes[1].slack.thread_ts, "100.1");
});

test("tagged Bot reply does not double wake", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, mention);
  await send(env, reply(`<@${BOT}> again`));
  assert.equal(wakes.length, 1); // message event ignored; app_mention would wake separately
});

test("bot message in sticky thread ignored", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, mention); wakes = [];
  await send(env, reply("bot says hi", { bot_id: "BPLACEHOLDER1", user: "UPLACEHOLDER2" }));
  await send(env, reply("edit", { subtype: "message_changed" }));
  assert.equal(wakes.length, 0);
});

test("other tag wakes with sticky_other_tag, keeps sticky, untagged still wakes", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, mention); wakes = [];
  await send(env, reply("<@UPLACEHOLDER2> your turn"));
  assert.ok(s.m.has(`sticky:${CH}:100.1`));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].sticky, true);
  assert.equal(wakes[0].sticky_other_tag, true);
  await send(env, reply("bot reply", { bot_id: "BPLACEHOLDER1", user: "UPLACEHOLDER2" }));
  assert.equal(wakes.length, 1);
  await send(env, reply("untagged now"));
  assert.equal(wakes.length, 2);
  assert.equal(wakes[1].sticky, true);
  assert.equal(wakes[1].sticky_other_tag, undefined);
});

test("kill switch off: no set, no wake", async () => {
  const s = kv(); const env = baseEnv(s, { STICKY_THREADS: "0" }); wakes = [];
  await send(env, mention);
  assert.equal(s.m.size, 0);
  s.m.set(`sticky:${CH}:100.1`, "{}"); wakes = [];
  await send(env, reply("untagged"));
  assert.equal(wakes.length, 0);
});

const ownRoot = (extra = {}) => ({
  type: "message", channel: CH, channel_type: "channel", user: BOT, bot_id: "BPLACEHOLDER5",
  subtype: "bot_message", ts: "300.1", text: "started", ...extra,
});

test("bot-started root claims; untagged human reply wakes; the root does not", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, ownRoot());
  assert.equal(wakes.length, 0);
  const saved = JSON.parse(s.m.get(`sticky:${CH}:300.1`));
  assert.equal(saved.by, BOT);
  assert.equal(saved.via, "bot");
  await send(env, reply("and what about blue?", { thread_ts: "300.1", ts: "300.5" }));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].kind, "app_mention");
  assert.equal(wakes[0].sticky, true);
  assert.equal(wakes[0].slack.thread_ts, "300.1");
});

test("a reply in someone else's thread does not claim it", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, ownRoot({ ts: "500.2", thread_ts: "500.1", text: "joining" }));
  assert.equal(s.m.has(`sticky:${CH}:500.1`), false);
  assert.equal(s.m.has(`sticky:${CH}:500.2`), false);
  await send(env, reply("hello", { thread_ts: "500.1", ts: "500.3" }));
  assert.equal(wakes.length, 0);
});

test("bot-started thread keeps tracking across other tags and ignores bot messages", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, ownRoot());
  await send(env, reply("<@UPLACEHOLDER2> your turn", { thread_ts: "300.1", ts: "300.2" }));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].sticky, true);
  assert.equal(wakes[0].sticky_other_tag, true);
  assert.ok(s.m.has(`sticky:${CH}:300.1`));
  await send(env, reply("bot says hi", { thread_ts: "300.1", ts: "300.3", bot_id: "BPLACEHOLDER1", user: "UPLACEHOLDER2" }));
  await send(env, ownRoot({ ts: "300.4", thread_ts: "300.1", text: "still here" }));
  assert.equal(wakes.length, 1);
  await send(env, reply("untagged now", { thread_ts: "300.1", ts: "300.6" }));
  assert.equal(wakes.length, 2);
  assert.equal(wakes[1].sticky, true);
  assert.equal(wakes[1].sticky_other_tag, undefined);
});

test("a later root event does not replace an existing owner", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  s.m.set(`sticky:${CH}:300.1`, JSON.stringify({ by: "UHUMAN", at: 1, via: "mention" }));
  await send(env, ownRoot());
  assert.deepEqual(JSON.parse(s.m.get(`sticky:${CH}:300.1`)), { by: "UHUMAN", at: 1, via: "mention" });
  assert.equal(wakes.length, 0);
});

test("silent channel does not claim or wake a bot-started thread", async () => {
  const s = kv(); const env = baseEnv(s, { SILENT_CHANNEL_IDS: CH }); wakes = [];
  await send(env, ownRoot());
  await send(env, reply("untagged", { thread_ts: "300.1", ts: "300.5" }));
  assert.equal(s.m.size, 0);
  assert.equal(wakes.length, 0);
});

test("noteOwnRootPost claims a root send and skips replies, DMs, silence, and an existing mark", async () => {
  const s = kv(); const env = baseEnv(s);
  await noteOwnRootPost(env, { channel: CH, text: "hello" }, { ok: true, ts: "400.1" });
  assert.equal(JSON.parse(s.m.get(`sticky:${CH}:400.1`)).via, "send");
  await noteOwnRootPost(env, { channel: CH, text: "again" }, { ok: true, ts: "400.1" });
  assert.equal(JSON.parse(s.m.get(`sticky:${CH}:400.1`)).via, "send");
  await noteOwnRootPost(env, { channel: CH, thread_ts: "400.1", text: "reply" }, { ok: true, ts: "400.2" });
  assert.equal(s.m.has(`sticky:${CH}:400.2`), false);
  await noteOwnRootPost(env, { channel: "DPLACEHOLDER1", text: "dm" }, { ok: true, ts: "400.3" });
  assert.equal(s.m.has("sticky:DPLACEHOLDER1:400.3"), false);
  await noteOwnRootPost({ ...env, SILENT_CHANNEL_IDS: CH }, { channel: CH, text: "muted" }, { ok: true, ts: "400.4" });
  assert.equal(s.m.has(`sticky:${CH}:400.4`), false);
  await noteOwnRootPost({ ...env, STICKY_THREADS: "0" }, { channel: CH, text: "off" }, { ok: true, ts: "400.5" });
  assert.equal(s.m.has(`sticky:${CH}:400.5`), false);
});

test("top-level untagged chatter never wakes", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, { type: "message", channel: CH, channel_type: "channel", user: "UHUMAN", ts: "200.1", text: "hello all, long enough message here" });
  assert.equal(wakes.length, 0);
});
