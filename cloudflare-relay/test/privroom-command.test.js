import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { privroomCommandsOf, slackSignature } from "../src/index.js";

const SECRET = "sec";
const ROOM = "CPLACEHOLDER4";
const OTHER = "CPLACEHOLDER8";
const ASKER = "UPLACEHOLDER9";
const ROSTER = JSON.stringify([
  { name: "BotA", userId: "UPLACEHOLDER2", botId: "BPLACEHOLDER1" },
  { name: "BotB", userId: "UPLACEHOLDER3", botId: "BPLACEHOLDER2" },
]);

const kv = () => {
  const m = new Map();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
};
const queue = () => {
  const sent = [];
  return { sent, send: async (body, opts) => { sent.push({ body, opts }); } };
};

let calls = [];
function installFetch() {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    if (init?.body) {
      try { body = JSON.parse(init.body); } catch { body = String(init.body); }
    }
    calls.push({ url: u, body });
    if (u.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "555.1" }));
    if (u.startsWith("https://grok.test")) return new Response("ok");
    return new Response(JSON.stringify({ ok: true, user: { id: "U", profile: {} } }));
  };
  return () => { globalThis.fetch = prev; };
}

function envOf(store, q, extra = {}) {
  return {
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_BOT_TOKEN: "xoxb-test",
    GROK_WEBHOOK_URL: "https://grok.test/hook",
    OWN_USER_ID: "UPLACEHOLDER6",
    PRIVROOM_STATE: store,
    PRIVROOM_SYNTH: q,
    PRIVROOM_BOTS: ROSTER,
    PRIVROOM_DELAY_SECONDS: "120",
    HONCHO_READ: "0",
    HONCHO_INGEST: "0",
    SILENT_RECORD: "0",
    ...extra,
  };
}

async function command(env, fields) {
  const raw = new URLSearchParams(fields).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await slackSignature(SECRET, ts, raw);
  const tasks = [];
  const res = await worker.fetch(new Request("https://relay.test/slack/commands", {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": sig,
    },
  }), env, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
  return res;
}

async function slackEvent(env, event) {
  const raw = JSON.stringify({ type: "event_callback", event_id: "Ev" + Math.random(), event });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await slackSignature(SECRET, ts, raw);
  const tasks = [];
  await worker.fetch(new Request("https://relay.test/slack/events", {
    method: "POST",
    body: raw,
    headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
  }), env, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
}

function wakes() {
  return calls.filter((c) => c.url.startsWith("https://grok.test")).map((c) => c.body);
}

test("command list defaults to /privroom and drops invalid tokens", () => {
  assert.deepEqual(privroomCommandsOf({}), ["/privroom"]);
  assert.deepEqual(privroomCommandsOf({ PRIVROOM_COMMANDS: "" }), ["/privroom"]);
  assert.deepEqual(privroomCommandsOf({ PRIVROOM_COMMANDS: "   " }), ["/privroom"]);
  assert.deepEqual(privroomCommandsOf({ PRIVROOM_COMMANDS: "not a command, !!!" }), ["/privroom"]);
  assert.deepEqual(
    privroomCommandsOf({ PRIVROOM_COMMANDS: "/sample-ask, sample-ask-2, /bad name, /sample-ask" }),
    ["/privroom", "/sample-ask", "/sample-ask-2"],
  );
});

test("unsigned command is rejected and an unknown command is ephemeral", async () => {
  const restore = installFetch();
  try {
    calls = [];
    const raw = "command=%2Fprivroom&text=hi";
    const res = await worker.fetch(new Request("https://relay.test/slack/commands", { method: "POST", body: raw }), {
      SLACK_SIGNING_SECRET: SECRET,
    }, { waitUntil() {} });
    assert.equal(res.status, 401);
    const env = envOf(kv(), queue());
    const unknown = await command(env, { command: "/sample-nope", text: "hi", channel_id: ROOM, user_id: ASKER });
    assert.equal((await unknown.json()).text, "Unknown command");
    assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
  } finally {
    restore();
  }
});

test("default /privroom and a configured alias post tags and arm one timer", async () => {
  const restore = installFetch();
  try {
    calls = [];
    const store = kv();
    const q = queue();
    const env = envOf(store, q, { PRIVROOM_COMMANDS: "/sample-ask" });
    const alias = await command(env, { command: "/Sample-Ask", text: "what now", channel_id: ROOM, user_id: ASKER });
    assert.equal((await alias.json()).text, "Sent");
    const post = calls.find((c) => c.url.includes("chat.postMessage"));
    assert.equal(post.body.channel, ROOM);
    assert.equal(post.body.text, "<@UPLACEHOLDER2> <@UPLACEHOLDER3> from: <@UPLACEHOLDER9>. what now");
    assert.equal(q.sent.length, 1);
    assert.deepEqual(q.sent[0].body, { channel: ROOM, ts: "555.1" });
    assert.equal(q.sent[0].opts.delaySeconds, 120);
    const saved = JSON.parse(store.m.get(`privroom:${ROOM}:555.1`));
    assert.equal(saved.question, "what now");
    assert.equal(saved.invoker, ASKER);
    assert.deepEqual(saved.replied, []);

    calls = [];
    const again = await command(envOf(kv(), queue()), {
      command: "/privroom", text: "still default", channel_id: ROOM, user_id: ASKER,
    });
    assert.equal((await again.json()).text, "Sent");
  } finally {
    restore();
  }
});

test("custom mention tags are posted, and a muted room does not post or queue", async () => {
  const restore = installFetch();
  try {
    calls = [];
    const store = kv();
    const q = queue();
    const tagged = await command(envOf(store, q, { PRIVROOM_MENTION_TAGS: "<@UPLACEHOLDER2> <@UPLACEHOLDER4>" }), {
      command: "/privroom", text: "tagged", channel_id: ROOM, user_id: ASKER,
    });
    assert.equal((await tagged.json()).text, "Sent");
    const post = calls.find((c) => c.url.includes("chat.postMessage"));
    assert.equal(post.body.text.startsWith("<@UPLACEHOLDER2> <@UPLACEHOLDER4> from:"), true);

    calls = [];
    const q2 = queue();
    const muted = await command(envOf(kv(), q2, { SILENT_CHANNEL_IDS: OTHER }), {
      command: "/privroom", text: "nope", channel_id: OTHER, user_id: ASKER,
    });
    assert.equal((await muted.json()).text, "This channel is muted.");
    assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
    assert.equal(q2.sent.length, 0);
  } finally {
    restore();
  }
});

test("all configured replies synthesize once and the timer does not synthesize again", async () => {
  const restore = installFetch();
  try {
    calls = [];
    const store = kv();
    const q = queue();
    const env = envOf(store, q);
    await command(env, { command: "/privroom", text: "both please", channel_id: ROOM, user_id: ASKER });
    await slackEvent(env, {
      type: "message", channel: ROOM, channel_type: "channel", user: "UPLACEHOLDER2", bot_id: "BPLACEHOLDER1",
      text: "one", ts: "555.2", thread_ts: "555.1",
    });
    assert.equal(wakes().length, 0);
    await slackEvent(env, {
      type: "message", channel: ROOM, channel_type: "channel", user: "UPLACEHOLDER3", bot_id: "BPLACEHOLDER2",
      text: "two", ts: "555.3", thread_ts: "555.1",
    });
    assert.equal(wakes().length, 1);
    assert.equal(wakes()[0].kind, "privroom_synthesize");
    assert.equal(wakes()[0].reason, "all_replied");
    assert.equal(wakes()[0].channel, ROOM);
    assert.equal(wakes()[0].thread_ts, "555.1");
    assert.equal(wakes()[0].question, "both please");
    assert.equal(wakes()[0].invoker, ASKER);
    assert.deepEqual(wakes()[0].replied, ["BotA", "BotB"]);
    assert.deepEqual(wakes()[0].missing, []);
    const acked = [];
    await worker.queue({
      messages: [{ body: { channel: ROOM, ts: "555.1" }, ack() { acked.push(1); }, retry() { acked.push(2); } }],
    }, env);
    assert.deepEqual(acked, [1]);
    assert.equal(wakes().length, 1);
  } finally {
    restore();
  }
});

test("the timer synthesizes once when replies are still missing", async () => {
  const restore = installFetch();
  try {
    calls = [];
    const store = kv();
    const env = envOf(store, queue());
    await command(env, { command: "/privroom", text: "wait", channel_id: ROOM, user_id: ASKER });
    await slackEvent(env, {
      type: "message", channel: ROOM, channel_type: "channel", user: "UPLACEHOLDER2", bot_id: "BPLACEHOLDER1",
      text: "only one", ts: "555.2", thread_ts: "555.1",
    });
    const acked = [];
    await worker.queue({
      messages: [{ body: { channel: ROOM, ts: "555.1" }, ack() { acked.push(1); }, retry() { acked.push(2); } }],
    }, env);
    assert.equal(wakes().length, 1);
    assert.equal(wakes()[0].reason, "timer");
    assert.deepEqual(wakes()[0].replied, ["BotA"]);
    assert.deepEqual(wakes()[0].missing, ["BotB"]);
    await slackEvent(env, {
      type: "message", channel: ROOM, channel_type: "channel", user: "UPLACEHOLDER3", bot_id: "BPLACEHOLDER2",
      text: "late", ts: "555.4", thread_ts: "555.1",
    });
    await worker.queue({
      messages: [{ body: { channel: ROOM, ts: "555.1" }, ack() { acked.push(1); }, retry() { acked.push(2); } }],
    }, env);
    assert.equal(wakes().length, 1);
    assert.deepEqual(acked, [1, 1]);
  } finally {
    restore();
  }
});
