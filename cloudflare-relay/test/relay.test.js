// Offline tests: no network. Run with `npm test` (Node 20+).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, {
  route, cfg, dropRetry, slackSignature,
  ackWithReaction, normalizeEmojiName, replyBroadcastFor, DEFAULT_ACK_EMOJI,
} from "../src/index.js";

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

test("event responses are immediate and carry the routing decision", async () => {
  const { res } = await post({ type: "event_callback", event_id: "Ev1", event: { type: "message", channel_type: "channel", channel: "COTHER", user: "UHUMAN", text: "hello there" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Relay-Action"), "ignore:not-watched");
});

test("ack emoji and reply_broadcast config", () => {
  assert.equal(normalizeEmojiName(undefined), DEFAULT_ACK_EMOJI);
  assert.equal(normalizeEmojiName("  "), DEFAULT_ACK_EMOJI);
  assert.equal(normalizeEmojiName(":custom_ack:"), "custom_ack");
  const c = cfg({});
  assert.equal(c.ackEmoji, "white_check_mark");
  assert.equal(c.replyBroadcast, true);
  assert.equal(c.holdAck, true);
  assert.equal(cfg({ ACK_EMOJI: "thumbsup" }).ackEmoji, "thumbsup");
  assert.equal(cfg({ HOLD_ACK: "false" }).holdAck, false);
  assert.equal(cfg({ REPLY_BROADCAST: "false" }).replyBroadcast, false);
  assert.equal(replyBroadcastFor({ channel: "C1", channel_type: "channel" }, c), true);
  assert.equal(replyBroadcastFor({ channel: "GPRIV", channel_type: "group" }, c), true);
  assert.equal(replyBroadcastFor({ channel: "C1" }, c), true);
  assert.equal(replyBroadcastFor({ channel: "D1", channel_type: "im" }, c), false);
  assert.equal(replyBroadcastFor({ channel: "GMPIM", channel_type: "mpim" }, c), false);
  assert.equal(replyBroadcastFor({ channel: "D1" }, c), false);
  assert.equal(replyBroadcastFor({ channel: "C1", channel_type: "channel" }, cfg({ REPLY_BROADCAST: "false" })), false);
});

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    let body = null;
    if (opts.body) {
      try { body = JSON.parse(opts.body); } catch { body = opts.body; }
    }
    const call = { url: String(url), body, method: opts.method || "GET" };
    calls.push(call);
    return impl(call);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map((x) => String(x)).join(" ")); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
}

const ackEnv = { SLACK_BOT_TOKEN: "xoxb-test" };

test("reaction ack: default emoji, no hold text", async () => {
  await withFetch(
    () => jsonResponse({ ok: true }),
    async (calls) => {
      const result = await ackWithReaction(ackEnv, cfg({}), "C1", "111.222", "hello");
      assert.equal(result.ok, true);
      assert.equal(result.name, "white_check_mark");
      assert.equal(result.fallback, false);
      const reactions = calls.filter((c) => c.url.includes("reactions.add"));
      assert.equal(reactions.length, 1);
      assert.deepEqual(reactions[0].body, { channel: "C1", timestamp: "111.222", name: "white_check_mark" });
      assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
    },
  );
});

test("reaction ack: custom emoji, invalid_name falls back to white_check_mark", async () => {
  await withFetch(
    (call) => {
      if (call.url.includes("reactions.add") && call.body?.name === "nope") {
        return jsonResponse({ ok: false, error: "invalid_name" });
      }
      return jsonResponse({ ok: true });
    },
    async (calls) => {
      const { result, lines } = await captureLogs(() =>
        ackWithReaction(ackEnv, cfg({ ACK_EMOJI: ":nope:" }), "C9", "2.2", "hi"));
      assert.equal(result.ok, true);
      assert.equal(result.fallback, true);
      assert.equal(result.name, "white_check_mark");
      const names = calls.filter((c) => c.url.includes("reactions.add")).map((c) => c.body.name);
      assert.deepEqual(names, ["nope", "white_check_mark"]);
      assert.match(lines.join("\n"), /invalid_name/);
      assert.doesNotMatch(lines.join("\n"), /failed/);
      assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
    },
  );
});

test("reaction ack: invalid_name on the default emoji does not loop", async () => {
  await withFetch(
    () => jsonResponse({ ok: false, error: "invalid_name" }),
    async (calls) => {
      const result = await ackWithReaction(ackEnv, cfg({}), "C1", "1.1", "hi");
      assert.equal(result.ok, false);
      assert.equal(result.error, "invalid_name");
      assert.equal(calls.filter((c) => c.url.includes("reactions.add")).length, 1);
    },
  );
});

test("reaction ack: already_reacted is success", async () => {
  await withFetch(
    () => jsonResponse({ ok: false, error: "already_reacted" }),
    async (calls) => {
      const { result, lines } = await captureLogs(() =>
        ackWithReaction(ackEnv, cfg({ ACK_EMOJI: "party" }), "C1", "1.1", "hi"));
      assert.equal(result.ok, true);
      assert.equal(result.already, true);
      assert.equal(result.fallback, false);
      assert.equal(calls.filter((c) => c.url.includes("reactions.add")).length, 1);
      assert.doesNotMatch(lines.join("\n"), /failed/);
      assert.match(lines.join("\n"), /already_reacted/);
    },
  );
});

test("reaction ack: missing_scope logs the reactions:write remedy", async () => {
  await withFetch(
    () => jsonResponse({ ok: false, error: "missing_scope" }),
    async () => {
      const { result, lines } = await captureLogs(() =>
        ackWithReaction(ackEnv, cfg({ ACK_EMOJI: "custom_ack" }), "C1", "1.1", "hi"));
      assert.equal(result.ok, false);
      assert.equal(result.error, "missing_scope");
      const text = lines.join("\n");
      assert.match(text, /missing_scope/);
      assert.match(text, /reactions:write/);
      assert.match(text, /reinstall/i);
    },
  );
});

test("reaction ack is skipped when HOLD_ACK is off or the skip regex matches", async () => {
  await withFetch(
    () => jsonResponse({ ok: true }),
    async (calls) => {
      const off = await ackWithReaction(ackEnv, cfg({ HOLD_ACK: "false" }), "C1", "1.1", "hello");
      assert.equal(off.skipped, true);
      const skipped = await ackWithReaction(
        ackEnv,
        cfg({ HOLD_ACK_SKIP_REGEX: "off-topic" }),
        "C1",
        "1.1",
        "this is off-topic",
      );
      assert.equal(skipped.skipped, true);
      assert.equal(calls.length, 0);
    },
  );
});

function liveEnv(extra = {}) {
  return {
    ...baseEnv,
    SLACK_BOT_TOKEN: "xoxb-test",
    GROK_WEBHOOK_URL: "https://grok.example/hook",
    ...extra,
  };
}

function slackAndWebhook(call, { reaction, webhookStatus = 200 } = {}) {
  if (call.url.startsWith("https://grok.example")) {
    return new Response(webhookStatus === 200 ? "ok" : "nope", { status: webhookStatus });
  }
  if (call.url.includes("users.info")) {
    return jsonResponse({ ok: true, user: { name: "ada", real_name: "Ada", profile: { display_name: "Ada" } } });
  }
  if (call.url.includes("reactions.add")) return jsonResponse(reaction || { ok: true });
  return jsonResponse({ ok: true });
}

test("mention wake reacts on the triggering ts and does not post hold text", async () => {
  await withFetch(
    (call) => slackAndWebhook(call),
    async (calls) => {
      const env = liveEnv({ ACK_EMOJI: "thumbsup" });
      const { waited } = await post({
        type: "event_callback",
        event_id: "EvAck",
        event: {
          type: "app_mention",
          channel: "C1",
          channel_type: "channel",
          user: "UHUMAN",
          text: `<@${ME}> hello`,
          ts: "111.222",
          thread_ts: "100.000",
        },
      }, { env });
      await Promise.all(waited);
      const reactions = calls.filter((c) => c.url.includes("reactions.add"));
      assert.equal(reactions.length, 1);
      assert.deepEqual(reactions[0].body, { channel: "C1", timestamp: "111.222", name: "thumbsup" });
      assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
      const wake = calls.find((c) => c.url.startsWith("https://grok.example"));
      assert.equal(wake.body.reply_broadcast, true);
      assert.equal(wake.body.hold_ack, "generic");
      assert.equal(wake.body.slack.ts, "111.222");
    },
  );
});

test("DM wake reacts and sets reply_broadcast false", async () => {
  await withFetch(
    (call) => slackAndWebhook(call),
    async (calls) => {
      const { waited } = await post({
        type: "event_callback",
        event_id: "EvDm",
        event: { type: "message", channel_type: "im", channel: "D1", user: "UHUMAN", text: "where is school pickup", ts: "9.9" },
      }, { env: liveEnv() });
      await Promise.all(waited);
      const reactions = calls.filter((c) => c.url.includes("reactions.add"));
      assert.equal(reactions.length, 1);
      assert.equal(reactions[0].body.timestamp, "9.9");
      assert.equal(reactions[0].body.name, "white_check_mark");
      assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
      const wake = calls.find((c) => c.url.startsWith("https://grok.example"));
      assert.equal(wake.body.reply_broadcast, false);
      assert.equal(wake.body.hold_ack, "personal");
    },
  );
});

test("channel-thread failure notice defaults reply_broadcast on, and off when configured", async () => {
  const event = {
    type: "event_callback",
    event_id: "EvFail",
    event: { type: "app_mention", channel: "C1", channel_type: "channel", user: "UHUMAN", text: `<@${ME}> hi`, ts: "5.5" },
  };
  await withFetch(
    (call) => slackAndWebhook(call, { webhookStatus: 500 }),
    async (calls) => {
      const { waited } = await post(event, { env: liveEnv() });
      await Promise.all(waited);
      const posts = calls.filter((c) => c.url.includes("chat.postMessage"));
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.reply_broadcast, true);
      assert.equal(posts[0].body.thread_ts, "5.5");
      assert.match(posts[0].body.text, /Could not reach Grok webhook/);
      assert.equal(calls.some((c) => c.url.includes("reactions.add")), false);
    },
  );
  await withFetch(
    (call) => slackAndWebhook(call, { webhookStatus: 500 }),
    async (calls) => {
      const { waited } = await post(event, { env: liveEnv({ REPLY_BROADCAST: "false" }) });
      await Promise.all(waited);
      const posts = calls.filter((c) => c.url.includes("chat.postMessage"));
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.reply_broadcast, false);
    },
  );
});

test("watched channel wake carries reply_broadcast and does not react", async () => {
  await withFetch(
    (call) => slackAndWebhook(call),
    async (calls) => {
      const { waited } = await post({
        type: "event_callback",
        event_id: "EvWatch",
        event: { type: "message", channel_type: "channel", channel: "CWATCH", user: "UHUMAN", text: "please look at the weekly form", ts: "4.4" },
      }, { env: liveEnv({ WATCH_CHANNEL_IDS: "CWATCH" }) });
      await Promise.all(waited);
      const wake = calls.find((c) => c.url.startsWith("https://grok.example"));
      assert.equal(wake.body.kind, "channel_message");
      assert.equal(wake.body.reply_broadcast, true);
      assert.equal(calls.some((c) => c.url.includes("reactions.add")), false);
      assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
    },
  );
});
