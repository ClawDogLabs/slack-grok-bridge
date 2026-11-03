// Offline tests: no network. Run with `npm test` (Node 20+).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { route, cfg, dropRetry, slackSignature } from "../src/index.js";

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
