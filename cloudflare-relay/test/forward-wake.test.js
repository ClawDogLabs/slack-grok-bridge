import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { slackSignature, forwardWakeTargets, forwardWakeEligible } from "../src/index.js";

const SECRET = "sec";
const ROOM = "CPLACEHOLDER1";
const MUTED = "CPLACEHOLDER2";
const ME = "UPLACEHOLDER1";       // this relay's bot user
const MY_BOT = "BPLACEHOLDER1";
const TARGET = "UPLACEHOLDER2";   // bot that only wakes on human tags
const TARGET_BOT = "BPLACEHOLDER2";
const HUMAN = "UPLACEHOLDER3";
const OTHER_BOT = "BPLACEHOLDER3";

function memKV() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}

let calls = [];
let hookStatus = 200;
function installFetch() {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    if (init?.body) { try { body = JSON.parse(init.body); } catch { body = String(init.body); } }
    calls.push({ url: u, body, headers: init?.headers || {} });
    if (u.startsWith("https://target.test")) {
      if (hookStatus === "throw") throw new Error("boom https://target.test/secret-path");
      return new Response("ok", { status: hookStatus });
    }
    if (u.startsWith("https://grok.test")) return new Response("ok");
    if (u.includes("conversations.replies") || u.includes("conversations.history")) return new Response(JSON.stringify({ ok: true, messages: [] }));
    if (u.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "555.1" }));
    return new Response(JSON.stringify({ ok: true, user: { id: "U", profile: {} } }));
  };
  return () => { globalThis.fetch = prev; };
}

const baseEnv = (extra = {}) => ({
  SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: "xoxb-test", GROK_WEBHOOK_URL: "https://grok.test/hook",
  OWN_USER_ID: ME, OWN_BOT_ID: MY_BOT, HONCHO_READ: "0", HONCHO_INGEST: "0", SILENT_RECORD: "0",
  STICKY_THREADS: "0",
  SILENT_CHANNEL_IDS: MUTED, BOT_REPLY_CAP: "3",
  FORWARD_WAKE: JSON.stringify({ [TARGET]: { secret: "TARGET_WEBHOOK", bot_id: TARGET_BOT } }),
  TARGET_WEBHOOK_URL: "https://target.test/hook", TARGET_WEBHOOK_KEY: "k-test",
  PRIVROOM_STATE: memKV(),
  ...extra,
});

async function send(env, event) {
  const raw = JSON.stringify({ type: "event_callback", event_id: "Ev" + Math.random(), event });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await slackSignature(SECRET, ts, raw);
  const tasks = [];
  const res = await worker.fetch(new Request("https://relay.test/slack/events", {
    method: "POST", body: raw, headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
  }), env, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
  return res;
}
const forwards = () => calls.filter((c) => c.url.startsWith("https://target.test"));
const ownWakes = () => calls.filter((c) => c.url.startsWith("https://grok.test"));
const botMsg = (extra = {}) => ({
  type: "message", subtype: "bot_message", channel: ROOM, channel_type: "channel", user: ME, bot_id: MY_BOT,
  text: `<@${TARGET}> did this wake you?`, ts: "2000.000100", thread_ts: "1999.000001", ...extra,
});

async function withFetch(fn) {
  const restore = installFetch();
  calls = [];
  const logs = [];
  const prevLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try { await fn(logs); } finally { restore(); console.log = prevLog; hookStatus = 200; }
}

test("config parsing: JSON and short form, rejects junk", () => {
  assert.deepEqual(forwardWakeTargets({ FORWARD_WAKE: `${TARGET}:TARGET_WEBHOOK` }), [{ userId: TARGET, secret: "TARGET_WEBHOOK", botId: null, humans: false }]);
  assert.equal(forwardWakeTargets({ FORWARD_WAKE: "" }).length, 0);
  assert.equal(forwardWakeTargets({ FORWARD_WAKE: "{bad" }).length, 0);
  assert.equal(forwardWakeTargets({ FORWARD_WAKE: JSON.stringify({ nope: { secret: "X" } }) }).length, 0);
  assert.equal(forwardWakeTargets({ FORWARD_WAKE: JSON.stringify({ [TARGET]: { secret: "lower-case" } }) }).length, 0);
});

test("own bot post tagging the target forwards once with bearer + automation key", async () => {
  await withFetch(async (logs) => {
    const env = baseEnv();
    const res = await send(env, botMsg());
    assert.equal(res.status, 200);
    const f = forwards();
    assert.equal(f.length, 1);
    assert.equal(f[0].headers.Authorization, "Bearer k-test");
    assert.equal(f[0].headers["X-Automation-Key"], "k-test");
    assert.equal(f[0].body.kind, "forwarded_mention");
    assert.equal(f[0].body.forwarded_for, TARGET);
    assert.equal(f[0].body.slack.channel, ROOM);
    assert.equal(f[0].body.slack.ts, "2000.000100");
    assert.equal(f[0].body.slack.thread_ts, "1999.000001");
    assert.equal(f[0].body.slack.author_is_bot, true);
    assert.equal(f[0].body.reply.thread_ts, "1999.000001");
    assert.equal(ownWakes().length, 0, "own bot posts never wake this relay");
    assert.ok(!logs.join("\n").includes("target.test") && !logs.join("\n").includes("k-test"));
  });
});

test("allow-listed other bot tagging the target forwards", async () => {
  await withFetch(async () => {
    await send(baseEnv(), botMsg({ user: "UPLACEHOLDER8", bot_id: OTHER_BOT, subtype: undefined }));
    assert.equal(forwards().length, 1);
  });
});

test("no tag, no forward", async () => {
  await withFetch(async () => {
    await send(baseEnv(), botMsg({ text: "no tag here" }));
    assert.equal(forwards().length, 0);
  });
});

test("human tag is skipped by default (target wakes natively), forwarded when humans:true", async () => {
  await withFetch(async () => {
    const human = { type: "message", channel: ROOM, channel_type: "channel", user: HUMAN, text: `<@${TARGET}> hi`, ts: "3000.1" };
    await send(baseEnv(), human);
    assert.equal(forwards().length, 0);
    await send(baseEnv({ FORWARD_WAKE: JSON.stringify({ [TARGET]: { secret: "TARGET_WEBHOOK", humans: true } }) }), human);
    assert.equal(forwards().length, 1);
    assert.equal(forwards()[0].body.slack.author_is_bot, false);
  });
});

test("same ts is forwarded only once (dedupe)", async () => {
  await withFetch(async () => {
    const env = baseEnv();
    await send(env, botMsg());
    await send(env, botMsg());
    assert.equal(forwards().length, 1);
  });
});

test("bot-authored forwards capped at BOT_REPLY_CAP per thread", async () => {
  await withFetch(async (logs) => {
    const env = baseEnv();
    for (let i = 0; i < 5; i++) await send(env, botMsg({ ts: `2000.00020${i}` }));
    assert.equal(forwards().length, 3);
    assert.ok(logs.some((l) => l.includes("forward-wake skip: bot cap")));
    await send(env, botMsg({ ts: "2100.1", thread_ts: "2099.1" }));
    assert.equal(forwards().length, 4, "other threads have their own cap");
  });
});

test("muted channel is never forwarded", async () => {
  await withFetch(async () => {
    await send(baseEnv(), botMsg({ channel: MUTED }));
    assert.equal(forwards().length, 0);
  });
});

test("target's own messages are skipped (by user or bot id)", async () => {
  await withFetch(async () => {
    await send(baseEnv(), botMsg({ user: TARGET, bot_id: TARGET_BOT, ts: "4000.1" }));
    await send(baseEnv(), botMsg({ user: undefined, bot_id: TARGET_BOT, ts: "4000.2" }));
    assert.equal(forwards().length, 0);
  });
});

test("missing secret skips with a log line, no URL", async () => {
  await withFetch(async (logs) => {
    await send(baseEnv({ TARGET_WEBHOOK_KEY: undefined }), botMsg());
    assert.equal(forwards().length, 0);
    assert.ok(logs.some((l) => l.includes("forward-wake skip: missing secret")));
  });
});

test("webhook failure logs without URL or key and does not block the relay's own wake", async () => {
  await withFetch(async (logs) => {
    hookStatus = "throw";
    const env = baseEnv();
    const mention = { type: "app_mention", channel: ROOM, channel_type: "channel", user: HUMAN, text: `<@${ME}> and <@${TARGET}> please both look`, ts: "5000.1" };
    await send({ ...env, FORWARD_WAKE: JSON.stringify({ [TARGET]: { secret: "TARGET_WEBHOOK", humans: true } }) }, mention);
    assert.equal(ownWakes().length, 1, "relay still wakes");
    assert.equal(forwards().length, 0, "app_mention events are not forwarded (message event covers it)");
    await send({ ...env, FORWARD_WAKE: JSON.stringify({ [TARGET]: { secret: "TARGET_WEBHOOK", humans: true } }) }, { ...mention, type: "message" });
    assert.equal(forwards().length, 1);
    const all = logs.join("\n");
    assert.ok(all.includes("forward-wake FAILED"));
    assert.ok(!all.includes("target.test") && !all.includes("k-test") && !all.includes("secret-path"));
  });
});

test("edits and non-forward subtypes are ignored; feature off when FORWARD_WAKE empty", async () => {
  const t = forwardWakeTargets(baseEnv())[0];
  assert.equal(forwardWakeEligible(botMsg({ subtype: "message_changed" }), t, baseEnv()).ok, false);
  assert.equal(forwardWakeEligible(botMsg({ edited: { ts: "1" } }), t, baseEnv()).ok, false);
  await withFetch(async () => {
    await send(baseEnv({ FORWARD_WAKE: "" }), botMsg());
    assert.equal(forwards().length, 0);
  });
});

test("no KV: skip rather than risk loops", async () => {
  await withFetch(async (logs) => {
    await send(baseEnv({ PRIVROOM_STATE: undefined }), botMsg());
    assert.equal(forwards().length, 0);
    assert.ok(logs.some((l) => l.includes("forward-wake skip: no KV")));
  });
});
