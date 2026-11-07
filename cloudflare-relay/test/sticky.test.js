import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { stickyEnabled, stickyOp, slackSignature } from "../src/index.js";

const BOT = "UPLACEHOLDER6";
const c = { ownUserId: BOT };
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

test("top-level untagged chatter never wakes", async () => {
  const s = kv(); const env = baseEnv(s); wakes = [];
  await send(env, { type: "message", channel: CH, channel_type: "channel", user: "UHUMAN", ts: "200.1", text: "hello all, long enough message here" });
  assert.equal(wakes.length, 0);
});
