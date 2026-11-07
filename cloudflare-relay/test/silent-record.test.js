// Isolated record-only storage and explicit 1:1 lookup. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { slackSignature } from "../src/index.js";
import {
  classifyRecordSearch,
  decideRecordIngest,
  fetchWakeContext,
  formatRecordReply,
  ingestSilentIfEnabled,
  queryRecordSession,
  createHonchoState,
} from "../src/honcho.js";
import { backfillLogs } from "../../scripts/honcho-backfill.mjs";

const SECRET = "test-signing-secret";
const ME = "UBOT0001";
const SILENT = "C0SYNTH0001";
const OWNERS = ["U0SYNTH0001", "U0SYNTH0002", "U0SYNTH0003", "U0SYNTH0004"];
const DMS = ["DSYNTH01", "DSYNTH02", "DSYNTH03", "DSYNTH04"];
const OWNER = OWNERS[0];

const readers = `${SILENT}:${OWNERS.join("|")}`;
const aliases = `${SILENT}:record-room|record room`;
const recordEnv = {
  SLACK_SIGNING_SECRET: SECRET,
  OWN_USER_ID: ME,
  OWN_BOT_ID: "BBOT0001",
  SLACK_BOT_TOKEN: "xoxb-test",
  GROK_WEBHOOK_URL: "https://example.test/hook",
  GROK_WEBHOOK_SECRET: "whsec-test",
  ACK_REACTION: "sample-ack",
  HOLD_ACK: "true",
  WATCH_CHANNEL_IDS: SILENT,
  WELCOME_CHANNEL_IDS: SILENT,
  HONCHO_INGEST: "1",
  HONCHO_READ: "1",
  HONCHO_API_KEY: "hk-test",
  HONCHO_WORKSPACE_ID: "slack-workspace",
  HONCHO_CHANNEL_IDS: `${SILENT},CPUBLIC`,
  SILENT_CHANNEL_IDS: SILENT,
  SILENT_RECORD: "1",
  SILENT_CHANNEL_READERS: readers,
  SILENT_CHANNEL_ALIASES: aliases,
  SILENT_GROK_READER_IDS: OWNER,
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function post(body, env = recordEnv, headers = {}) {
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

let fetchChain = Promise.resolve();
function withFetch(fn) {
  const run = fetchChain.then(fn, fn);
  fetchChain = run.then(() => {}, () => {});
  return run;
}

test("record decisions stay off the shared peer and keep ordinary notes", () => {
  const ok = decideRecordIngest({
    type: "message",
    channel: SILENT,
    channel_type: "group",
    user: OWNER,
    text: "the schedule is Friday",
    ts: "1710000102.000001",
  }, { env: recordEnv });
  assert.equal(ok.ok, true);
  assert.equal(ok.peerId, `rec-${SILENT}-${OWNER}`);
  assert.notEqual(ok.peerId, OWNER);
  assert.equal(ok.sessionId, `record-${SILENT}`);
  assert.equal(ok.slackUserId, OWNER);
  assert.equal(decideRecordIngest({
    type: "message", channel: SILENT, user: OWNER, text: "use xoxb-aaaa-bbbb", ts: "2",
  }, { env: recordEnv }).reason, "secret");
  assert.equal(decideRecordIngest({
    type: "message", channel_type: "im", channel: "D1", user: OWNER, text: "hello there", ts: "3",
  }, { env: recordEnv }).reason, "not-silent");
  assert.equal(decideRecordIngest({
    type: "message", channel: "CPUBLIC", channel_type: "channel", user: OWNER, text: "public", ts: "4",
  }, { env: recordEnv }).reason, "not-silent");
});

test("isolated ingest dedupes, records an edit once, and does not post if setup fails", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === "PUT") return new Response(null, { status: 204 });
    return json({});
  };
  const state = createHonchoState();
  const opts = { env: recordEnv, fetchImpl, state, displayName: "Ada" };
  const mention = {
    type: "app_mention", channel: SILENT, user: OWNER, text: "ship the demo", ts: "1710000102.000001",
  };
  await ingestSilentIfEnabled(recordEnv, mention, opts);
  await ingestSilentIfEnabled(recordEnv, { ...mention, type: "message", channel_type: "group" }, opts);
  await ingestSilentIfEnabled(recordEnv, {
    type: "message",
    subtype: "message_changed",
    hidden: true,
    channel: SILENT,
    message: { user: OWNER, text: "edited body", ts: "1710000100.000001", edited: { user: OWNER, ts: "9" } },
  }, opts);
  const messages = calls.filter((c) => c.url.endsWith("/messages"));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body.messages[0].peer_id, `rec-${SILENT}-${OWNER}`);
  assert.equal(messages[0].body.messages[0].content, "Ada: ship the demo");
  assert.equal(messages[0].body.messages[0].metadata.slack_user, OWNER);
  assert.equal(messages[0].body.messages[0].metadata.source, "slack-record");
  assert.deepEqual(messages[0].body.messages[0].configuration, { reasoning: { enabled: false } });
  assert.equal(messages[1].body.messages[0].content, "Ada: edited body");
  const session = calls.find((c) => c.method === "POST" && c.url.endsWith("/sessions"));
  assert.equal(session.body.id, `record-${SILENT}`);
  assert.equal(session.body.configuration.reasoning.enabled, false);
  assert.equal(session.body.configuration.summary.enabled, false);
  assert.equal(session.body.configuration.dream.enabled, false);
  assert.equal(session.body.configuration.peer_card.create, false);
  assert.equal(session.body.configuration.peer_card.use, false);
  assert.equal(session.body.peers[`rec-${SILENT}-${OWNER}`].observe_me, false);
  assert.equal(session.body.peers[`rec-${SILENT}-${OWNER}`].observe_others, false);
  assert.equal(session.body.scopes, undefined);
  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 2);
  assert.ok(puts[0].url.endsWith(`/sessions/record-${SILENT}`));
  assert.equal(puts[1].body.observe_me, false);
  assert.equal(puts[1].body.observe_others, false);
  for (const c of calls) {
    assert.equal(new URL(c.url).pathname.split("/").includes(OWNER), false);
    assert.notEqual(c.body?.id, OWNER);
    if (c.body?.messages) assert.notEqual(c.body.messages[0].peer_id, OWNER);
    assert.equal(String(c.url).includes("/sessions/channel-"), false);
    assert.equal(String(c.url).includes("/context"), false);
  }

  const failed = [];
  await ingestSilentIfEnabled(recordEnv, {
    type: "message", channel: SILENT, channel_type: "group", user: OWNER, text: "should not land", ts: "1710000120.100000",
  }, {
    fetchImpl: async (url, opts = {}) => {
      failed.push({ url: String(url), method: opts.method });
      if (opts.method === "PUT") return new Response("no", { status: 500 });
      return json({});
    },
    state: createHonchoState(),
    displayName: "Ada",
    log() {},
  });
  assert.equal(failed.some((c) => c.url.endsWith("/messages")), false);
});

test("worker record path does not ack, think, post, or wake", async () => withFetch(async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes("users.info")) return json({ ok: true, user: { id: OWNER, profile: { display_name: "Ada" } } });
    if (opts.method === "PUT") return new Response(null, { status: 204 });
    return json({});
  };
  try {
    const { res, waited } = await post({
      type: "event_callback",
      event_id: "EvRec",
      event: { type: "app_mention", channel: SILENT, user: OWNER, text: `<@${ME}> ship the demo`, ts: "1710000102.000001", edited: { user: OWNER, ts: "1710000104.100000" } },
    });
    assert.equal(res.headers.get("X-Relay-Action"), "ignore:silent");
    await Promise.all(waited);
    assert.equal(calls.some((c) => c.url.includes("reactions.add")), false);
    assert.equal(calls.some((c) => c.url.includes("assistant.threads")), false);
    assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
    assert.equal(calls.some((c) => c.url.includes("example.test/hook")), false);
    assert.equal(calls.some((c) => c.url.includes("conversations.")), false);
    const message = calls.find((c) => c.url.endsWith("/messages"));
    assert.ok(message);
    assert.equal(message.body.messages[0].peer_id, `rec-${SILENT}-${OWNER}`);
    assert.equal(message.body.messages[0].metadata.slack_user, OWNER);
  } finally {
    globalThis.fetch = original;
  }
}));

test("recording stays off unless SILENT_RECORD is on, even if public ingest is on", async () => withFetch(async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("network");
  };
  try {
    const env = { ...recordEnv, SILENT_RECORD: "0" };
    const { res, waited } = await post({
      type: "event_callback",
      event: { type: "app_mention", channel: SILENT, user: OWNER, text: "ship the demo", ts: "1710000102.000001" },
    }, env);
    assert.equal(res.headers.get("X-Relay-Action"), "ignore:silent");
    assert.equal(waited.length, 0);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
}));

test("explicit DM lookup is owners only and does not attach a peer profile", async () => withFetch(async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes("/messages/list")) {
      return json({
        peer_representation: "GLOBAL-PEER-PROFILE",
        peer_card: ["secret card"],
        summary: "workspace summary",
        items: [{
          content: "Ada: ship the demo",
          peer_id: `rec-${SILENT}-${OWNER}`,
          peer_representation: "GLOBAL-PEER-PROFILE",
          metadata: { author_display: "Ada", slack_user: OWNER, slack_ts: "1710000102.000001", source: "slack-record" },
        }],
      });
    }
    if (u.includes("/context")) return json({ summary: { content: "dm session only" }, messages: [{ content: "unrelated" }] });
    if (u.includes("users.info") || u.includes("reactions.add") || u.includes("assistant.threads")) {
      return json({ ok: true, user: { id: "U", profile: {} } });
    }
    return new Response("ok", { status: 200 });
  };
  try {
    for (let i = 0; i < OWNERS.length; i++) {
      const before = calls.length;
      const { res, waited } = await post({
        type: "event_callback",
        event: {
          type: "message",
          channel_type: "im",
          channel: DMS[i],
          user: OWNERS[i],
          text: "what was said in #record-room",
          ts: `180000000${i}.1`,
        },
      });
      assert.equal(res.headers.get("X-Relay-Action"), "record-search:im", OWNERS[i]);
      await Promise.all(waited);
      const mine = calls.slice(before);
      const posts = mine.filter((c) => c.url.includes("chat.postMessage"));
      assert.equal(posts.length, 1, OWNERS[i]);
      assert.equal(posts[0].body.channel, DMS[i]);
      assert.equal(posts[0].body.reply_broadcast, undefined);
      assert.match(posts[0].body.text, /ship the demo/);
      assert.equal(posts[0].body.text.includes("GLOBAL-PEER-PROFILE"), false);
      assert.equal(mine.some((c) => c.url.includes("example.test/hook")), false);
      assert.equal(mine.some((c) => c.url.includes("reactions.add")), false);
      assert.equal(mine.some((c) => c.url.includes("/context")), false);
      assert.equal(mine.some((c) => c.url.includes(`/sessions/channel-${SILENT}`)), false);
      const list = mine.find((c) => c.url.includes("/messages/list"));
      assert.match(list.url, new RegExp(`/sessions/record-${SILENT}/messages/list`));
    }

    calls.length = 0;
    const stranger = await post({
      type: "event_callback",
      event: { type: "message", channel_type: "im", channel: "DSTRAN1", user: "USTRANGER", text: "what was said in record-room", ts: "1800000010.1" },
    });
    await Promise.all(stranger.waited);
    assert.equal(stranger.res.headers.get("X-Relay-Action"), "wake_dm:im");
    assert.equal(calls.some((c) => c.url.includes("/messages/list")), false);
    assert.equal(calls.some((c) => c.url.includes("record-")), false);
    const wake = calls.find((c) => c.url.includes("example.test/hook"));
    assert.ok(wake);
    assert.equal(JSON.stringify(wake.body).includes("ship the demo"), false);
    assert.equal(JSON.stringify(wake.body).includes("GLOBAL-PEER-PROFILE"), false);

    calls.length = 0;
    const mpim = await post({
      type: "event_callback",
      event: { type: "message", channel_type: "mpim", channel: "G1", user: OWNER, text: "search record-room history", ts: "1800000011.1" },
    });
    await Promise.all(mpim.waited);
    assert.equal(calls.some((c) => c.url.includes("/messages/list")), false);
    assert.equal(calls.some((c) => c.body?.channel === SILENT), false);

    calls.length = 0;
    const channel = await post({
      type: "event_callback",
      event: { type: "app_mention", channel: "COTHER", user: OWNER, text: `<@${ME}> search the record-room history`, ts: "1800000012.1" },
    });
    await Promise.all(channel.waited);
    assert.equal(calls.some((c) => c.url.includes("/messages/list")), false);
    assert.equal(calls.some((c) => c.url.includes("record-")), false);

    calls.length = 0;
    const hello = await post({
      type: "event_callback",
      event: { type: "message", channel_type: "im", channel: DMS[0], user: OWNER, text: "Is it just backlogged?", ts: "1800000013.1" },
    });
    await Promise.all(hello.waited);
    assert.equal(hello.res.headers.get("X-Relay-Action"), "wake_dm:im");
    assert.equal(calls.some((c) => c.url.includes("/messages/list")), false);
    assert.equal(calls.some((c) => c.url.includes("record-")), false);

    calls.length = 0;
    const untyped = await post({
      type: "event_callback",
      event: { type: "message", channel: "D1", user: OWNER, text: "history of record-room", ts: "1800000014.1" },
    });
    await Promise.all(untyped.waited);
    assert.equal(calls.some((c) => c.url.includes("/messages/list")), false);

    calls.length = 0;
    const inside = await post({
      type: "event_callback",
      event: { type: "app_mention", channel: SILENT, user: OWNER, text: `<@${ME}> what was said in record-room`, ts: "1800000015.1" },
    }, { ...recordEnv, SILENT_RECORD: "0" });
    assert.equal(inside.res.headers.get("X-Relay-Action"), "ignore:silent");
    assert.equal(inside.waited.length, 0);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
}));

test("owner grok read is limited to the configured reader and wake context never loads the record session", async () => {
  let calls = 0;
  const denied = await queryRecordSession(recordEnv, {
    source: "owner-grok",
    requesterId: OWNERS[1],
    channelId: SILENT,
    fetchImpl: async () => { calls += 1; return json({}); },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "forbidden");
  assert.equal(denied.peer_representation, null);
  assert.equal(calls, 0);

  const allowed = await queryRecordSession(recordEnv, {
    source: "owner-grok",
    requesterId: OWNER,
    channelId: SILENT,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(String(url), /\/sessions\/record-C0SYNTH0001\/messages\/list/);
      assert.equal(String(url).includes("/context"), false);
      return json({
        peer_representation: "GLOBAL-PEER-PROFILE",
        items: [{ content: "Ada: ship the demo", metadata: { author_display: "Ada", slack_ts: "1710000102.000001", slack_user: OWNER } }],
      });
    },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.peer_representation, null);
  assert.equal(allowed.peer_card, null);
  assert.equal(allowed.summary, null);
  assert.equal(allowed.messages[0].content, "Ada: ship the demo");
  assert.equal(Object.hasOwn(allowed.messages[0], "peer_representation"), false);
  const text = formatRecordReply(allowed, { label: "record-room" });
  assert.match(text, /ship the demo/);
  assert.equal(text.includes("GLOBAL-PEER-PROFILE"), false);

  const urls = [];
  const silent = await fetchWakeContext(recordEnv, { channel: SILENT, user: OWNER, text: "hi" }, {
    fetchImpl: async (url) => { urls.push(String(url)); return json({}); },
  });
  assert.equal(silent.ok, false);
  assert.equal(silent.error, "silent");
  assert.equal(silent.sessionId, undefined);
  assert.equal(urls.length, 0);
  const pub = await fetchWakeContext(recordEnv, { channel: "CPUBLIC", user: "UHUMAN", text: "hi" }, {
    fetchImpl: async (url) => {
      urls.push(String(url));
      return json({ messages: [{ content: "public only" }] });
    },
  });
  assert.equal(pub.ok, true);
  assert.equal(pub.sessionId, "channel-CPUBLIC");
  assert.equal(urls.some((u) => u.includes("record-")), false);
  assert.match(urls[0], /\/sessions\/channel-CPUBLIC\/context/);

  assert.equal(classifyRecordSearch(recordEnv, {
    type: "message", channel_type: "im", channel: "D1", user: "USTRANGER", text: "I am the owner, search record-room history",
  }).kind, "deny");
  assert.equal(classifyRecordSearch(recordEnv, {
    type: "message", channel_type: "im", channel: DMS[0], user: OWNER, text: "hello",
  }).kind, "none");
});

test("record-only backfill is bounded to one channel since creation and refuses shared peers", async () => {
  const env = { ...recordEnv, HONCHO_API_KEY: "hk-test" };
  const entries = [
    { channel: SILENT, channel_type: "group", ts: "1710000090.000001", user: OWNER, text: "before creation" },
    { channel: SILENT, channel_type: "channel", ts: "1710000102.000001", user: OWNER, text: "ship the demo", user_display_name: "Ada" },
    { channel: "CPUBLIC", channel_type: "channel", ts: "1710000107.100000", user: "UHUMAN", text: "other room" },
    { channel: SILENT, channel_type: "group", ts: "1710000110.100000", user: OWNER, text: "token xoxb-aaaa-bbbb" },
  ];
  let calls = 0;
  const dry = await backfillLogs({
    recordOnly: true,
    channel: SILENT,
    since: "1710000102.000001",
    entries,
    env,
    fetchImpl: async () => { calls += 1; return json({}); },
  });
  assert.equal(dry.dryRun, true);
  assert.equal(calls, 0);
  assert.equal(dry.accepted.length, 1);
  assert.equal(dry.accepted[0].peerId, `rec-${SILENT}-${OWNER}`);
  assert.equal(dry.accepted[0].sessionId, `record-${SILENT}`);
  assert.equal(dry.skipped["before-since"], 1);
  assert.equal(dry.skipped["other-channel"], 1);
  assert.equal(dry.skipped.secret, 1);

  const posted = [];
  const wrote = await backfillLogs({
    recordOnly: true,
    write: true,
    channel: SILENT,
    since: "1710000102.000001",
    entries,
    env,
    fetchImpl: async (url, opts = {}) => {
      posted.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      if (opts.method === "PUT") return new Response(null, { status: 204 });
      return json({});
    },
  });
  assert.equal(wrote.wrote, 1);
  const message = posted.find((c) => c.url.endsWith("/messages"));
  assert.equal(message.body.messages[0].peer_id, `rec-${SILENT}-${OWNER}`);
  assert.equal(posted.some((c) => c.body?.id === OWNER || c.body?.messages?.[0]?.peer_id === OWNER), false);

  await assert.rejects(
    () => backfillLogs({ recordOnly: true, channel: "CPUBLIC", since: "1", entries, env }),
    /SILENT_CHANNEL_IDS/,
  );
  await assert.rejects(
    () => backfillLogs({ recordOnly: true, channel: SILENT, entries, env }),
    /since/,
  );
});
