// Offline tests: no network beyond localhost. Run with `npm test` (Node 20+).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRelayServer } from "../server.js";
import { slackSignature } from "../../cloudflare-relay/src/index.js";

const SECRET = "test-signing-secret";
const env = { SLACK_SIGNING_SECRET: SECRET, OWN_USER_ID: "UBOT0001", OWN_BOT_ID: "BBOT0001" };
let server, base;

before(async () => {
  server = createRelayServer(env);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function signedPost(body, extra = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}/slack/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": await slackSignature(SECRET, ts, raw), ...extra },
    body: raw,
  });
}

test("health", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("rejects unsigned POST", async () => {
  const res = await fetch(`${base}/slack/events`, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
});

test("answers url_verification", async () => {
  const res = await signedPost({ type: "url_verification", challenge: "abc123" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { challenge: "abc123" });
});

test("passes routing debug header through", async () => {
  const res = await signedPost(
    { type: "event_callback", event: { type: "message", channel_type: "im", channel: "D1", user: "UHUMAN", text: "hi", ts: "1.1" } },
    { "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-relay-action"), "ignore:retry");
});

test("unknown path is 404", async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
