// Offline tests: no network. Run with `npm test` (Node 20+).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { route, cfg, dropRetry, slackSignature, ackEmoji, replyFields, postMessageArgs } from "../src/index.js";

const SECRET = "test-signing-secret";
const ME = "UBOT0001";
const baseEnv = { SLACK_SIGNING_SECRET: SECRET, OWN_USER_ID: ME, OWN_BOT_ID: "BBOT0001" };

async function post(body, { env = baseEnv, sign = true, headers = {} } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const h = { "Content-Type": "application/json", ...headers };
  if (sign) {
    h["X-Slack-Request-Timestamp"] = ts;
    h["X-Slack-Signature"] = await slackSignature(SECRET, ts, raw);
  }
  const waited = [];
  const res = await worker.fetch(new Request("https://relay.test/slack/events", { method: "POST", headers: h, body: raw }), env, { waitUntil: (p) => waited.push(p) });
  return { res, waited };
}

test("rejects unsigned and badly signed requests", async () => {
  assert.equal((await post({ type: "url_verification", challenge: "x" }, { sign: false })).res.status, 401);
  const raw = JSON.stringify({ type: "url_verification", challenge: "x" });
  const res = await worker.fetch(new Request("https://relay.test/slack/events", {
    method: "POST", body: raw,
    headers: { "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000)), "X-Slack-Signature": "v0=deadbeef" },
  }), baseEnv, { waitUntil() {} });
  assert.equal(res.status, 401);
});

test("fails closed without a signing secret", async () => {
  assert.equal((await post({ type: "url_verification", challenge: "x" }, { env: {} })).res.status, 503);
});

test("answers url_verification", async () => {
  const { res } = await post({ type: "url_verification", challenge: "abc123" });
  assert.deepEqual(await res.json(), { challenge: "abc123" });
});

test("retry policy", async () => {
  const c = cfg({});
  assert.equal(dropRetry("http_timeout", c), true);
  assert.equal(dropRetry("http_error", c), false);
  assert.equal(dropRetry("http_error", cfg({ RETRY_POLICY: "drop_all" })), true);
  assert.equal(dropRetry("http_timeout", cfg({ RETRY_POLICY: "process_all" })), false);
  const { res, waited } = await post(
    { type: "event_callback", event: { type: "message", channel_type: "im", channel: "D1", user: "UHUMAN", text: "hi", ts: "1.1" } },
    { headers: { "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" } },
  );
  assert.equal(res.headers.get("X-Relay-Action"), "ignore:retry");
  assert.equal(waited.length, 0);
});

test("routing", () => {
  const c = cfg({ ...baseEnv, WATCH_CHANNEL_IDS: "CWATCH", WELCOME_CHANNEL_IDS: "CWELCOME", BOT_NAME: "mybot" });
  const r = (e) => route(e, c).action;
  assert.equal(r({ type: "app_mention", channel: "C1", user: "UHUMAN", text: `<@${ME}> hi` }), "wake_mention");
  assert.equal(r({ type: "app_mention", channel: "C1", bot_id: "BOTHER", text: `<@${ME}>` }), "ignore");
  const allowedBot = cfg({ ...baseEnv, ALLOW_BOT_IDS: "BOTHER" });
  assert.equal(route({ type: "app_mention", channel: "C1", bot_id: "BOTHER", text: `<@${ME}>` }, allowedBot).action, "wake_mention");
  assert.equal(r({ type: "app_mention", channel: "D1", user: "UHUMAN", text: `<@${ME}>` }), "ignore");
  assert.equal(r({ type: "message", channel_type: "im", channel: "D1", user: "UHUMAN", text: "hi" }), "wake_dm");
  assert.equal(r({ type: "message", channel_type: "im", channel: "D1", user: "UHUMAN", subtype: "file_share", text: "" }), "wake_dm");
  assert.equal(r({ type: "message", channel_type: "im", channel: "D1", user: ME, text: "my own reply" }), "ignore");
  assert.equal(r({ type: "message", channel_type: "im", channel: "D1", bot_id: "BOTHER", text: "x" }), "ignore");
  assert.equal(r({ type: "message", channel_type: "im", channel: "D1", user: "UHUMAN", subtype: "message_changed" }), "ignore");
  assert.equal(r({ type: "message", channel_type: "mpim", channel: "G1", user: "UHUMAN", text: "lunch?" }), "wake_dm");
  assert.equal(r({ type: "message", channel_type: "channel", channel: "COTHER", user: "UHUMAN", text: "what time is it?" }), "ignore");
  assert.equal(r({ type: "message", channel_type: "channel", channel: "CWATCH", user: "UHUMAN", text: "ok" }), "ignore");
  assert.equal(r({ type: "message", channel_type: "channel", channel: "CWATCH", user: "UHUMAN", text: "mybot where is the form" }), "watched");
  assert.equal(r({ type: "message", channel_type: "channel", channel: "CWATCH", user: "UHUMAN", text: `<@${ME}> hi?` }), "ignore");
  assert.equal(r({ type: "message", subtype: "channel_join", channel: "CWELCOME", user: "UNEW" }), "welcome");
  assert.equal(r({ type: "message", subtype: "channel_join", channel: "COTHER", user: "UNEW" }), "ignore");
  const strict = cfg({ ...baseEnv, MPIM_REQUIRE_ADDRESS: "true", BOT_NAME: "mybot" });
  assert.equal(route({ type: "message", channel_type: "mpim", channel: "G1", user: "UHUMAN", text: "lunch?" }, strict).action, "ignore");
  assert.equal(route({ type: "message", channel_type: "mpim", channel: "G1", user: "UHUMAN", text: "mybot lunch?" }, strict).action, "wake_dm");
});

test("ack emoji and reply placement", () => {
  assert.equal(ackEmoji(undefined), "white_check_mark");
  assert.equal(ackEmoji(""), "white_check_mark");
  assert.equal(ackEmoji(":thumbsup:"), "thumbsup");
  assert.equal(ackEmoji("off"), null);
  assert.equal(ackEmoji("false"), null);
  assert.equal(ackEmoji("none"), null);
  assert.equal(cfg({}).holdAck, false);
  assert.equal(cfg({ HOLD_ACK: "true" }).holdAck, true);
  assert.equal(cfg({}).ackReaction, "white_check_mark");
  assert.equal(cfg({ ACK_REACTION: "off" }).ackReaction, null);
  assert.equal(cfg({}).botReplyCap, 3);
  assert.equal(cfg({ BOT_REPLY_CAP: "5" }).botReplyCap, 5);
  assert.equal(cfg({ BOT_REPLY_CAP: "nope" }).botReplyCap, 3);

  assert.deepEqual(replyFields({ channel: "D1", channel_type: "im", ts: "1.1" }), { thread_ts: null, reply_broadcast: false });
  assert.deepEqual(replyFields({ channel: "D1", channel_type: "im", ts: "2.2", thread_ts: "1.1" }), { thread_ts: "1.1", reply_broadcast: false });
  assert.deepEqual(replyFields({ channel: "G1", channel_type: "mpim", ts: "1.1" }), { thread_ts: null, reply_broadcast: false });
  assert.deepEqual(replyFields({ channel: "C1", channel_type: "channel", ts: "1.1" }), { thread_ts: "1.1", reply_broadcast: true });
  assert.deepEqual(replyFields({ channel: "C1", channel_type: "channel", ts: "2.2", thread_ts: "1.1" }), { thread_ts: "1.1", reply_broadcast: true });
  assert.deepEqual(replyFields({ channel: "C1", ts: "1.1" }), { thread_ts: "1.1", reply_broadcast: true });
  assert.deepEqual(replyFields({ channel: "D9", ts: "1.1" }), { thread_ts: null, reply_broadcast: false });
  assert.deepEqual(
    postMessageArgs("D1", "hi", { thread_ts: null, reply_broadcast: false }),
    { channel: "D1", text: "hi" },
  );
  assert.deepEqual(
    postMessageArgs("C1", "hi", { thread_ts: "1.1", reply_broadcast: true }),
    { channel: "C1", text: "hi", thread_ts: "1.1", reply_broadcast: true },
  );
});

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// node:test runs cases concurrently. These share global fetch, so queue them.
let fetchChain = Promise.resolve();
function withMockFetch(impl, fn) {
  const run = fetchChain.then(async () => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
  });
  fetchChain = run.then(() => {}, () => {});
  return run;
}

test("reaction ack falls back when the custom emoji is missing and does not post a text hold-ack", async () => {
  const calls = [];
  await withMockFetch(async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, body });
    if (u.includes("reactions.add")) {
      if (body.name === "party_parrot") return jsonResponse({ ok: false, error: "invalid_name" });
      return jsonResponse({ ok: true });
    }
    if (u.includes("users.info")) return jsonResponse({ ok: true, user: { id: "UHUMAN", name: "someone", profile: {} } });
    if (u.includes("assistant.threads")) return jsonResponse({ ok: true });
    return new Response("ok", { status: 200 });
  }, async () => {
    const { waited } = await post(
      { type: "event_callback", event: { type: "message", channel_type: "im", channel: "D1", user: "UHUMAN", text: "hello there", ts: "1.1" } },
      { env: { ...baseEnv, SLACK_BOT_TOKEN: "xoxb-test", ACK_REACTION: "party_parrot", GROK_WEBHOOK_URL: "https://example.test/hook" } },
    );
    await Promise.all(waited);
    const reactions = calls.filter((c) => c.url.includes("reactions.add")).map((c) => c.body.name);
    assert.deepEqual(reactions, ["party_parrot", "white_check_mark"]);
    assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
    const wake = calls.find((c) => c.url.includes("example.test/hook"));
    assert.equal(wake.body.reply.thread_ts, null);
    assert.equal(wake.body.reply.reply_broadcast, false);
  });
});

test("missing reactions:write is not retried with another emoji", async () => {
  const calls = [];
  await withMockFetch(async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, body });
    if (u.includes("reactions.add")) return jsonResponse({ ok: false, error: "missing_scope" });
    if (u.includes("users.info")) return jsonResponse({ ok: true, user: { id: "UHUMAN", name: "someone", profile: {} } });
    if (u.includes("assistant.threads")) return jsonResponse({ ok: true });
    if (u.includes("conversations.info")) return jsonResponse({ ok: false, error: "missing_scope" });
    return new Response("ok", { status: 200 });
  }, async () => {
    const { waited } = await post(
      { type: "event_callback", event: { type: "app_mention", channel: "C1", user: "UHUMAN", text: `<@${ME}> hi`, ts: "3.3" } },
      { env: { ...baseEnv, SLACK_BOT_TOKEN: "xoxb-test", ACK_REACTION: "custom_ack", GROK_WEBHOOK_URL: "https://example.test/hook" } },
    );
    await Promise.all(waited);
    const reactions = calls.filter((c) => c.url.includes("reactions.add"));
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].body.name, "custom_ack");
    const wake = calls.find((c) => c.url.includes("example.test/hook"));
    assert.ok(wake, "webhook was called");
    assert.equal(wake.body.reply.thread_ts, "3.3");
    assert.equal(wake.body.reply.reply_broadcast, true);
  });
});

test("opt-in text hold-ack follows the threading rule", async () => {
  const calls = [];
  await withMockFetch(async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes("conversations.info")) {
      const mpim = u.includes("channel=G1");
      return jsonResponse({ ok: true, channel: { is_mpim: mpim, is_channel: !mpim } });
    }
    if (u.includes("chat.postMessage") || u.includes("reactions.add") || u.includes("assistant.threads") || u.includes("users.info")) {
      return jsonResponse({ ok: true, user: { id: "UHUMAN", name: "someone", profile: {} } });
    }
    return new Response("ok", { status: 200 });
  }, async () => {
    const env = { ...baseEnv, SLACK_BOT_TOKEN: "xoxb-test", HOLD_ACK: "true", ACK_REACTION: "off", GROK_WEBHOOK_URL: "https://example.test/hook" };
    const channelMention = await post(
      { type: "event_callback", event: { type: "app_mention", channel: "C1", user: "UHUMAN", text: `<@${ME}> status?`, ts: "5.5" } },
      { env },
    );
    await Promise.all(channelMention.waited);
    const groupDm = await post(
      { type: "event_callback", event: { type: "app_mention", channel: "G1", user: "UHUMAN", text: `<@${ME}> status?`, ts: "6.6" } },
      { env },
    );
    await Promise.all(groupDm.waited);
    const posts = calls.filter((c) => c.url.includes("chat.postMessage")).map((c) => c.body);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].thread_ts, "5.5");
    assert.equal(posts[0].reply_broadcast, true);
    assert.equal(posts[1].thread_ts, undefined);
    assert.equal(posts[1].reply_broadcast, undefined);
    assert.equal(calls.some((c) => c.url.includes("reactions.add")), false);
  });
});

test("bot reply cap ignores further allow-listed bot mentions in a thread", async () => {
  const calls = [];
  let replies = { ok: true, messages: [] };
  await withMockFetch(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("conversations.replies")) {
      const q = new URL(u).searchParams;
      assert.equal(q.get("limit"), "200");
      assert.equal(q.get("channel"), "C1");
      assert.equal(q.get("ts"), "1.1");
      return jsonResponse(replies);
    }
    if (u.includes("conversations.info")) return jsonResponse({ ok: true, channel: { is_channel: true } });
    if (u.includes("users.info")) return jsonResponse({ ok: true, user: { id: "UBOTUSER", name: "otherbot", is_bot: true, profile: {} } });
    if (u.includes("reactions.add") || u.includes("assistant.threads")) return jsonResponse({ ok: true });
    return new Response("ok", { status: 200 });
  }, async () => {
    const env = {
      ...baseEnv,
      SLACK_BOT_TOKEN: "xoxb-test",
      GROK_WEBHOOK_URL: "https://example.test/hook",
      ALLOW_BOT_IDS: "BOTHER",
      ACK_REACTION: "off",
    };
    const mention = (event, extra = {}) => post({ type: "event_callback", event }, { env: { ...env, ...extra } });
    const woke = () => calls.some((u) => u.includes("example.test/hook"));
    const readThread = () => calls.some((u) => u.includes("conversations.replies"));
    const reset = () => { calls.length = 0; };

    reset();
    const human = await mention({ type: "app_mention", channel: "C1", user: "UHUMAN", text: `<@${ME}> hi`, ts: "2.2", thread_ts: "1.1" });
    await Promise.all(human.waited);
    assert.equal(readThread(), false);
    assert.equal(woke(), true);

    reset();
    const top = await mention({ type: "app_mention", channel: "C1", bot_id: "BOTHER", user: "UBOTUSER", text: `<@${ME}> hi`, ts: "3.3" });
    await Promise.all(top.waited);
    assert.equal(readThread(), false);
    assert.equal(woke(), true);

    reset();
    replies = { ok: true, messages: [{ bot_id: "BOTHER" }, { bot_id: "BOTHER" }, { bot_id: "BBOT0001" }, { bot_id: "BOTHER" }] };
    const under = await mention({ type: "app_mention", channel: "C1", bot_id: "BOTHER", user: "UBOTUSER", text: `<@${ME}> hi`, ts: "4.4", thread_ts: "1.1" });
    await Promise.all(under.waited);
    assert.equal(readThread(), true);
    assert.equal(woke(), true);

    reset();
    replies = { ok: true, messages: [{ bot_id: "BOTHER" }, { bot_id: "BOTHER" }, { bot_id: "BOTHER" }, { bot_id: "BOTHER" }] };
    const over = await mention({ type: "app_mention", channel: "C1", bot_id: "BOTHER", user: "UBOTUSER", subtype: "bot_message", text: `<@${ME}> again`, ts: "5.5", thread_ts: "1.1" });
    await Promise.all(over.waited);
    assert.equal(readThread(), true);
    assert.equal(woke(), false);

    reset();
    replies = { ok: false, error: "missing_scope" };
    const closed = await mention({ type: "app_mention", channel: "C1", bot_id: "BOTHER", text: `<@${ME}> hi`, ts: "6.6", thread_ts: "1.1" });
    await Promise.all(closed.waited);
    assert.equal(readThread(), true);
    assert.equal(woke(), false);

    reset();
    replies = { ok: true, messages: [{ bot_id: "BOTHER" }, { bot_id: "BOTHER" }] };
    const tight = await mention(
      { type: "app_mention", channel: "C1", bot_id: "BOTHER", text: `<@${ME}> hi`, ts: "7.7", thread_ts: "1.1" },
      { BOT_REPLY_CAP: "1" },
    );
    await Promise.all(tight.waited);
    assert.equal(woke(), false);
  });
});

test("event responses are immediate and carry the routing decision", async () => {
  const { res } = await post({ type: "event_callback", event_id: "Ev1", event: { type: "message", channel_type: "channel", channel: "COTHER", user: "UHUMAN", text: "hello there" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Relay-Action"), "ignore:not-watched");
});
