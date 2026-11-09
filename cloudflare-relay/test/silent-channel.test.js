// Mute guard. No network. Proves a listed channel never acks, thinks, posts, or wakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { cfg, route, slackSignature, silentSlackWriteBlocked } from "../src/index.js";
import { createHonchoState, eventChannelId, ingestIfEnabled, isSilentEvent } from "../src/honcho.js";
import { backfillLogs } from "../../scripts/honcho-backfill.mjs";

const SECRET = "test-signing-secret";
const ME = "UBOT0001";
const SILENT = "C0SYNTH0001";
const OWNER = "U0SYNTH0001";
const baseEnv = {
  SLACK_SIGNING_SECRET: SECRET,
  OWN_USER_ID: ME,
  OWN_BOT_ID: "BBOT0001",
  SLACK_BOT_TOKEN: "xoxb-test",
  GROK_WEBHOOK_URL: "https://example.test/hook",
  GROK_WEBHOOK_SECRET: "whsec-test",
  ACK_REACTION: "sample-ack",
  HOLD_ACK: "true",
  WATCH_CHANNEL_IDS: `${SILENT},CWATCH`,
  WELCOME_CHANNEL_IDS: `${SILENT},CWELCOME`,
  HONCHO_INGEST: "1",
  HONCHO_READ: "1",
  HONCHO_API_KEY: "hk-test",
  HONCHO_WORKSPACE_ID: "slack-workspace",
  HONCHO_CHANNEL_IDS: `${SILENT},CPUBLIC`,
  SILENT_CHANNEL_IDS: SILENT,
};

async function post(body, { env = baseEnv, headers = {} } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const waited = [];
  const res = await worker.fetch(new Request("https://relay.test/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": await slackSignature(SECRET, ts, raw),
      ...headers,
    },
    body: raw,
  }), env, { waitUntil: (p) => waited.push(p) });
  return { res, waited };
}

function callback(event, extra = {}) {
  return { type: "event_callback", event_id: "EvSilent", ...extra, event };
}

// node:test runs cases concurrently. Queue the cases that replace global fetch.
let fetchChain = Promise.resolve();
function withFetch(fn) {
  const run = fetchChain.then(fn, fn);
  fetchChain = run.then(() => {}, () => {});
  return run;
}

test("silent channel id is taken from edits, joins, and nested messages", () => {
  assert.equal(eventChannelId({ channel: SILENT }), SILENT);
  assert.equal(eventChannelId({ channel_id: SILENT }), SILENT);
  assert.equal(eventChannelId({
    subtype: "message_changed",
    message: { channel: SILENT, text: "edited", ts: "1710000100.000001" },
  }), SILENT);
  assert.equal(eventChannelId({ item: { channel: SILENT } }), SILENT);
  assert.equal(isSilentEvent(baseEnv, { channel: "COTHER" }), false);
  assert.equal(isSilentEvent({ SILENT_CHANNEL_IDS: "" }, { channel: SILENT }), false);
  assert.equal(isSilentEvent({}, { channel: SILENT }), false);
});

test("route mutes before watch, welcome, and mention, and leaves other channels alone", () => {
  const c = cfg(baseEnv);
  assert.equal(c.silent.has(SILENT), true);
  const edited = {
    type: "app_mention",
    channel: SILENT,
    user: OWNER,
    text: `<@${ME}> edited`,
    ts: "1710000100.000001",
    edited: { user: OWNER, ts: "1710000101.000001" },
  };
  assert.deepEqual(route(edited, c), { action: "ignore", reason: "silent" });
  assert.equal(route({ type: "app_mention", channel: SILENT, user: OWNER, text: `<@${ME}> hi`, ts: "1710000102.000001" }, c).reason, "silent");
  assert.equal(route({ type: "message", subtype: "channel_join", channel: SILENT, user: "UNEW", ts: "1" }, c).reason, "silent");
  assert.equal(route({ type: "message", subtype: "group_join", channel: SILENT, user: "UNEW", ts: "1" }, c).reason, "silent");
  assert.equal(route({ type: "member_joined_channel", channel: SILENT, user: OWNER }, c).reason, "silent");
  assert.equal(route({
    type: "message",
    channel_type: "group",
    channel: SILENT,
    user: OWNER,
    text: `<@${ME}> thread`,
    ts: "1710000106.000001",
    thread_ts: "1710000100.000001",
  }, c).reason, "silent");
  assert.equal(route({
    type: "message",
    channel_type: "channel",
    channel: "CWATCH",
    user: "UHUMAN",
    text: "please look at the experiment log today",
    ts: "8.8",
  }, c).action, "watched");
  assert.equal(route({ type: "app_mention", channel: "COTHER", user: "UHUMAN", text: `<@${ME}> hi`, ts: "3.3" }, c).action, "wake_mention");
  assert.equal(route({ type: "message", subtype: "channel_join", channel: "CWELCOME", user: "UNEW", ts: "9" }, c).action, "welcome");
});

test("slack write helper blocks reactions, status, and posts only for listed channels", () => {
  assert.equal(silentSlackWriteBlocked(baseEnv, { channel: SILENT, name: "sample-ack", timestamp: "1710000102.000001" }), true);
  assert.equal(silentSlackWriteBlocked(baseEnv, { channel_id: SILENT, status: "is thinking…", thread_ts: "1710000102.000001" }), true);
  assert.equal(silentSlackWriteBlocked(baseEnv, { channel: SILENT, text: "Got it - checking with the owner and will get back to you." }), true);
  assert.equal(silentSlackWriteBlocked(baseEnv, { channel: "D1", text: "hi" }), false);
  assert.equal(silentSlackWriteBlocked(baseEnv, { channel: "CWATCH", name: "white_check_mark" }), false);
  assert.equal(silentSlackWriteBlocked({ SILENT_CHANNEL_IDS: "" }, { channel: SILENT, name: "sample-ack" }), false);
});

test("muted events make no Slack, Honcho, or wake calls, including the observed edits", async () => withFetch(async () => {
  const events = [
    {
      type: "app_mention",
      user: OWNER,
      text: `<@${ME}> edited mention`,
      ts: "1710000100.000001",
      channel: SILENT,
      edited: { user: OWNER, ts: "1710000101.000001" },
    },
    {
      type: "app_mention",
      user: OWNER,
      text: `<@${ME}> hey`,
      ts: "1710000102.000001",
      channel: SILENT,
    },
    {
      type: "message",
      channel: SILENT,
      channel_type: "group",
      user: OWNER,
      text: `<@${ME}> hey`,
      ts: "1710000102.000001",
    },
    {
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel: SILENT,
      ts: "1710000104.000001",
      message: {
        type: "message",
        user: OWNER,
        text: `<@${ME}> edited body`,
        ts: "1710000100.000001",
        edited: { user: OWNER, ts: "1710000104.000001" },
      },
    },
    {
      type: "message",
      subtype: "message_changed",
      hidden: true,
      ts: "1710000105.000001",
      message: {
        channel: SILENT,
        user: OWNER,
        text: "channel only on the nested message",
        ts: "1710000100.000001",
        edited: { user: OWNER, ts: "1710000105.000001" },
      },
    },
    {
      type: "message",
      channel: SILENT,
      channel_type: "group",
      user: OWNER,
      text: `<@${ME}> in the thread`,
      ts: "1710000106.000001",
      thread_ts: "1710000100.000001",
    },
    {
      type: "message",
      subtype: "channel_join",
      channel: SILENT,
      user: "UNEW",
      text: "<@UNEW> has joined the channel",
      ts: "1710000107.000001",
    },
    {
      type: "message",
      subtype: "group_join",
      channel: SILENT,
      user: "UNEW",
      text: "<@UNEW> has joined the private channel",
      ts: "1710000108.000001",
    },
    {
      type: "member_joined_channel",
      user: OWNER,
      channel: SILENT,
      channel_type: "G",
      ts: "1710000109.000001",
    },
    {
      type: "message",
      channel: SILENT,
      channel_type: "group",
      user: OWNER,
      subtype: "slack_audio",
      text: "",
      ts: "1710000110.000001",
      files: [{ id: "F1", mimetype: "audio/mp4", filetype: "m4a" }],
    },
  ];
  const retries = [
    { "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" },
    { "X-Slack-Retry-Num": "2", "X-Slack-Retry-Reason": "http_error" },
  ];
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("muted channel issued a network call");
  };
  try {
    for (const event of events) {
      const { res, waited } = await post(callback(event));
      assert.equal(res.status, 200, event.ts || event.type);
      assert.equal(res.headers.get("X-Relay-Action"), "ignore:silent");
      assert.deepEqual(await res.json(), { ok: true, action: "ignore", reason: "silent" });
      assert.equal(waited.length, 0);
    }
    for (const headers of retries) {
      const { res, waited } = await post(callback(events[1]), { headers });
      assert.equal(res.headers.get("X-Relay-Action"), "ignore:silent");
      assert.equal(waited.length, 0);
    }
    const processAll = await post(callback(events[0]), { env: { ...baseEnv, RETRY_POLICY: "process_all" }, headers: retries[0] });
    assert.equal(processAll.res.headers.get("X-Relay-Action"), "ignore:silent");
    assert.equal(processAll.waited.length, 0);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
}));

test("an unlisted channel still acks with sample-ack and wakes", async () => withFetch(async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, body });
    if (u.includes("reactions.add") || u.includes("assistant.threads") || u.includes("users.info")) {
      return new Response(JSON.stringify({ ok: true, user: { id: "UHUMAN", name: "someone", profile: {} } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("ok", { status: 200 });
  };
  try {
    const { res, waited } = await post(callback({
      type: "app_mention",
      channel: "COTHER",
      user: "UHUMAN",
      text: `<@${ME}> status?`,
      ts: "1710000099.000100",
    }));
    assert.equal(res.headers.get("X-Relay-Action"), "wake_mention:app_mention");
    await Promise.all(waited);
    const reaction = calls.find((c) => c.url.includes("reactions.add"));
    assert.ok(reaction, "unlisted mention still acks");
    assert.equal(reaction.body.name, "sample-ack");
    assert.equal(reaction.body.channel, "COTHER");
    const thinking = calls.find((c) => c.url.includes("assistant.threads.setStatus") && c.body?.status === "is thinking…");
    assert.ok(thinking);
    assert.equal(thinking.body.channel_id, "COTHER");
    const wake = calls.find((c) => c.url.includes("example.test/hook"));
    assert.ok(wake);
    assert.equal(wake.body.slack.channel, "COTHER");
    assert.equal(calls.some((c) => c.body?.channel === SILENT || c.body?.channel_id === SILENT), false);
    const watched = await post(callback({
      type: "message",
      channel_type: "channel",
      channel: "CWATCH",
      user: "UHUMAN",
      text: "please look at the experiment log today",
      ts: "1710000099.000200",
    }));
    assert.equal(watched.res.headers.get("X-Relay-Action"), "watched:watched-channel");
    await Promise.all(watched.waited);
    assert.equal(calls.some((c) => c.url.includes("example.test/hook") && c.body?.slack?.channel === "CWATCH"), true);
  } finally {
    globalThis.fetch = original;
  }
}));

test("silent channels are not public-ingested and backfill skips them", async () => {
  const urls = [];
  const bodies = [];
  const fetchImpl = async (url, opts = {}) => {
    urls.push(String(url));
    bodies.push(opts.body ? JSON.parse(opts.body) : null);
    return new Response("{}", { status: 200 });
  };
  const state = createHonchoState();
  const task = ingestIfEnabled(
    baseEnv,
    { type: "message", channel_type: "channel", channel: SILENT, user: OWNER, text: "private note", ts: "1710000102.000001" },
    { fetchImpl, state, log() {} },
  );
  assert.equal(task, null);
  const other = ingestIfEnabled(
    baseEnv,
    { type: "message", channel_type: "channel", channel: "CPUBLIC", user: "UHUMAN", text: "public note stays", ts: "1710000001.000100" },
    { fetchImpl, state, log() {} },
  );
  await other;
  assert.equal(urls.some((u) => u.includes(SILENT)), false);
  const message = bodies.find((b) => b?.messages);
  assert.equal(message.messages[0].peer_id, "UHUMAN");
  assert.equal(message.messages[0].content.includes("public note stays"), true);
  assert.equal(urls.filter((u) => u.endsWith("/messages")).length, 1);
  const result = await backfillLogs({
    entries: [
      { channel: SILENT, channel_type: "group", ts: "1710000102.000001", user: OWNER, text: "do not store on the shared peer" },
      { channel: SILENT, channel_type: "channel", ts: "1710000103.000001", user: OWNER, text: "still not a public peer write" },
      { channel: "CPUBLIC", channel_type: "channel", ts: "1710000002.000100", user: "UHUMAN", text: "public note stays" },
    ],
    env: { ...baseEnv, HONCHO_CHANNEL_IDS: `${SILENT},CPUBLIC` },
    channelIds: `${SILENT},CPUBLIC`,
    fetchImpl,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.skipped.silent, 2);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].channel, "CPUBLIC");
  assert.equal(result.accepted[0].peerId, "UHUMAN");
  assert.equal(urls.filter((u) => u.endsWith("/messages")).length, 1);
});

test("mute runs before ensureSelf, route, wake, and hold-ack in both hosts", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workerSrc = fs.readFileSync(path.join(root, "cloudflare-relay/src/index.js"), "utf8");
  const socket = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const muteAt = workerSrc.indexOf("Mute before auth.test");
  const ensureAt = workerSrc.indexOf("await ensureSelf(env)");
  const routeAt = workerSrc.indexOf("const { action, reason } = route(e, c)");
  const waitAt = workerSrc.indexOf("ctx.waitUntil(handle");
  assert.ok(muteAt > 0 && ensureAt > muteAt && routeAt > muteAt && waitAt > muteAt);
  const inbound = workerSrc.slice(workerSrc.indexOf("async function processInbound"), workerSrc.indexOf("async function forwardWatched"));
  assert.ok(inbound.indexOf("if (isSilentEvent(env, e)) return;") < inbound.indexOf("addAckReaction"));
  assert.ok(inbound.indexOf("if (isSilentEvent(env, e)) return;") < inbound.indexOf("wakeGrok"));
  assert.ok(inbound.indexOf("if (isSilentEvent(env, e)) return;") < inbound.indexOf("postHoldAck"));
  const mention = socket.slice(socket.indexOf('app.event("app_mention"'), socket.indexOf("app.message("));
  assert.ok(mention.indexOf("isSilentEvent(event)") < mention.indexOf("setThinking"));
  assert.ok(mention.indexOf("isSilentEvent(event)") < mention.indexOf("processInbound"));
  const message = socket.slice(socket.indexOf("app.message("));
  assert.ok(message.indexOf("isSilentEvent(message)") < message.indexOf("fireHonchoIngest"));
  assert.ok(message.indexOf("isSilentEvent(message)") < message.indexOf("setThinking"));
});
