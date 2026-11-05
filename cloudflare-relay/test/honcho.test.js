// Offline tests: no network. Run with `npm test` from cloudflare-relay/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  honchoIngestEnabled,
  decideIngest,
  isPublicChannel,
  sensitiveReason,
  ingestIfEnabled,
  sendIngest,
  materialize,
  createHonchoState,
  sessionIdForChannel,
  buildPersonalRe,
  resolveIngestChannel,
  mapLogPeer,
  botLabelSet,
  resetHonchoState,
} from "../src/honcho.js";
import { backfillLogs } from "../../scripts/honcho-backfill.mjs";

const personalRe = buildPersonalRe("");

function pub(over = {}) {
  return {
    type: "message",
    channel_type: "channel",
    channel: "C123",
    user: "UHUMAN",
    text: "the experiment notes are in the repo",
    ts: "1710000000.000100",
    ...over,
  };
}

test("kill switch defaults off", () => {
  assert.equal(honchoIngestEnabled({}), false);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: undefined }), false);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: "" }), false);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: "0" }), false);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: "false" }), false);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: "off" }), false);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: "no" }), false);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: "maybe" }), false);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: "1" }), true);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: "true" }), true);
  assert.equal(honchoIngestEnabled({ HONCHO_INGEST: " YES " }), true);
});

test("public channels only", () => {
  assert.equal(isPublicChannel({ channel_type: "channel", channel: "C1" }), true);
  assert.equal(isPublicChannel({ channel: "C1" }), false);
  assert.equal(isPublicChannel({ channel: "C0CF63G4CMA" }), false);
  assert.equal(isPublicChannel({ channel_type: "im", channel: "D1" }), false);
  assert.equal(isPublicChannel({ channel_type: "mpim", channel: "G1" }), false);
  assert.equal(isPublicChannel({ channel_type: "group", channel: "G1" }), false);
  assert.equal(isPublicChannel({ channel: "D1" }), false);
  assert.equal(isPublicChannel({ channel: "GPRIVATE" }), false);
  assert.equal(decideIngest(pub(), { personalRe }).ok, true);
  assert.equal(decideIngest(pub({ channel_type: "im", channel: "D1" }), { personalRe }).reason, "not-public");
  assert.equal(decideIngest(pub({ channel_type: "mpim", channel: "G1" }), { personalRe }).reason, "not-public");
  assert.equal(decideIngest(pub({ channel_type: "group", channel: "G9" }), { personalRe }).reason, "not-public");
  assert.equal(decideIngest({ type: "message", channel: "C0CF63G4CMA", user: "U1", text: "hello there", ts: "1710000000.1" }, { personalRe }).reason, "not-public");
});

test("missing channel_type uses allowlist, then conversations.info, else needs-channel-type", async () => {
  const text = "the readout looks stable";
  const base = { type: "message", user: "U1", text, ts: "1710000000.2" };
  const cache = new Map();
  let lookups = 0;
  const lookup = async (channel) => {
    lookups += 1;
    if (channel === "C0CF63G4CMA") return { is_mpim: true };
    if (channel === "C0CEMRX1Z0E") return { is_private: true, is_group: true };
    if (channel === "CPUB") return { is_channel: true };
    return null;
  };
  const mpim = await resolveIngestChannel({ ...base, channel: "C0CF63G4CMA" }, { lookup, cache });
  const priv = await resolveIngestChannel({ ...base, channel: "C0CEMRX1Z0E" }, { lookup, cache });
  const pubCh = await resolveIngestChannel({ ...base, channel: "CPUB" }, { lookup, cache });
  const again = await resolveIngestChannel({ ...base, channel: "CPUB", ts: "1710000000.3" }, { lookup, cache });
  assert.equal(mpim.reason, "not-public");
  assert.equal(priv.reason, "not-public");
  assert.equal(pubCh.ok, true);
  assert.equal(pubCh.event.channel_type, "channel");
  assert.equal(again.ok, true);
  assert.equal(lookups, 3);

  const failed = await resolveIngestChannel(
    { ...base, channel: "C0CF63G4CMA", ts: "1710000000.4" },
    { lookup: async () => null, cache: new Map() },
  );
  assert.equal(failed.reason, "needs-channel-type");

  let allowLookups = 0;
  const listed = await resolveIngestChannel(
    { ...base, channel: "CPUB" },
    { allowlist: "CPUB,COTHER", lookup: async () => { allowLookups += 1; return { is_mpim: true }; } },
  );
  const blocked = await resolveIngestChannel(
    { ...base, channel: "C0CF63G4CMA" },
    { allowlist: "CPUB" },
  );
  assert.equal(listed.ok, true);
  assert.equal(allowLookups, 0);
  assert.equal(blocked.reason, "not-allowlisted");
});

test("log label dinky maps to OWN_USER_ID and is never the peer id", () => {
  const labels = botLabelSet("Dinky");
  const mapped = mapLogPeer("dinky", { ownUserId: "UBOTDINKY", labels });
  assert.equal(mapped.peerId, "UBOTDINKY");
  assert.notEqual(mapped.peerId, "dinky");
  assert.equal(mapLogPeer("Dinky", { ownUserId: "UBOTDINKY", labels }).peerId, "UBOTDINKY");
  assert.equal(mapLogPeer("@dinky", { ownUserId: "UBOTDINKY", labels }).peerId, "UBOTDINKY");
  assert.equal(mapLogPeer("dinky", { ownUserId: "", labels }).peerId, null);
  assert.equal(mapLogPeer("UHUMAN1", { ownUserId: "UBOTDINKY", labels }).peerId, "UHUMAN1");
  assert.equal(mapLogPeer("jason", { ownUserId: "UBOTDINKY", labels }).peerId, null);
});

test("privacy filter drops personal text, tokens, key urls, addresses, and finances", () => {
  const skip = (text) => decideIngest(pub({ text }), { personalRe }).reason;
  assert.equal(skip("what time is pickup"), "personal");
  assert.equal(skip("my home is near the lab"), "personal");
  assert.equal(skip("email me the pdf"), "personal");
  assert.equal(sensitiveReason("token xoxb-1234-abcd"), "secret");
  assert.equal(skip("here is xoxb-1234-abcd please rotate"), "secret");
  assert.equal(skip("see https://hooks.slack.com/services/T/B/xxx"), "secret");
  assert.equal(skip("download https://files.slack.com/files-pri/T1/download/secret"), "secret");
  assert.equal(skip("callback https://example.com/cb?token=abcdef"), "secret");
  assert.equal(skip("meet at 123 Main Street tomorrow"), "address");
  assert.equal(skip("card 4111 1111 1111 1111"), "finance");
  assert.equal(skip("ssn 123-45-6789"), "finance");
  assert.equal(skip("send the bank account details"), "finance");
  assert.equal(decideIngest(pub({ text: "the readout looks stable" }), { personalRe }).ok, true);
});

test("skips empty and bot noise, but keeps our own public replies", () => {
  const ids = { ownUserId: "UBOT", ownBotId: "BBOT", personalRe };
  assert.equal(decideIngest(pub({ text: "   " }), ids).reason, "empty");
  assert.equal(decideIngest(pub({ text: "" }), ids).reason, "empty");
  assert.equal(decideIngest(pub({ subtype: "message_changed" }), ids).reason, "subtype");
  assert.equal(decideIngest(pub({ subtype: "channel_join", text: "joined" }), ids).reason, "subtype");
  assert.equal(decideIngest(pub({ bot_id: "BOTHER", text: "other bot" }), ids).reason, "bot");
  assert.equal(decideIngest(pub({ subtype: "bot_message", bot_id: "BOTHER", text: "nope" }), ids).reason, "bot");
  const own = decideIngest(pub({ user: "UBOT", bot_id: "BBOT", subtype: "bot_message", text: "shipped the notes" }), ids);
  assert.equal(own.ok, true);
  assert.equal(own.peerId, "UBOT");
  assert.equal(decideIngest(pub({ subtype: "file_share", text: "plot attached" }), ids).ok, true);
});

test("session id is one per channel and content carries author plus slack ts", async () => {
  assert.equal(sessionIdForChannel("C123"), "channel-C123");
  const decision = decideIngest(pub(), { personalRe });
  const prepared = await materialize(decision, { displayName: "Ada Lovelace" });
  assert.equal(prepared.sessionId, "channel-C123");
  assert.equal(prepared.content, "Ada Lovelace: the experiment notes are in the repo");
  assert.equal(prepared.metadata.slack_ts, "1710000000.000100");
  assert.equal(prepared.metadata.channel, "C123");
  assert.equal(prepared.metadata.author_display, "Ada Lovelace");
  assert.ok(prepared.createdAt.startsWith("2024-"));
  const fallback = await materialize(decision, {});
  assert.equal(fallback.content.startsWith("UHUMAN: "), true);
});

test("ingest is a no-op when the kill switch is off and does not call fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  const task = ingestIfEnabled(
    { HONCHO_INGEST: "0", HONCHO_API_KEY: "should-not-be-sent" },
    pub(),
    { personalRe, fetchImpl, state: createHonchoState() },
  );
  assert.equal(task, null);
  assert.equal(calls, 0);
  const unset = ingestIfEnabled({ HONCHO_API_KEY: "k" }, pub(), { personalRe, fetchImpl, state: createHonchoState() });
  assert.equal(unset, null);
  assert.equal(calls, 0);
});

test("enabled ingest posts workspace, peer, session, and message without a second setup", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    return new Response("{}", { status: url.endsWith("/messages") ? 201 : 200 });
  };
  const env = { HONCHO_INGEST: "1", HONCHO_API_KEY: "hk-test", HONCHO_WORKSPACE_ID: "princeton-ai-slack" };
  const state = createHonchoState();
  const opts = { personalRe, fetchImpl, state, displayName: "Ada" };
  await ingestIfEnabled(env, pub(), opts);
  await ingestIfEnabled(env, pub({ ts: "1710000001.000200", text: "second note is up" }), opts);

  assert.equal(calls[0].auth, "Bearer hk-test");
  assert.equal(calls[0].url, "https://api.honcho.dev/v3/workspaces");
  assert.deepEqual(calls[0].body, { id: "princeton-ai-slack" });
  assert.equal(calls.some((c) => c.url.endsWith("/peers") && c.body.id === "UHUMAN"), true);
  assert.equal(calls.some((c) => c.url.endsWith("/sessions") && c.body.id === "channel-C123"), true);
  const messages = calls.filter((c) => c.url.endsWith("/messages"));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body.messages[0].content, "Ada: the experiment notes are in the repo");
  assert.equal(messages[0].body.messages[0].peer_id, "UHUMAN");
  assert.equal(messages[0].body.messages[0].metadata.slack_ts, "1710000000.000100");
  assert.equal(calls.filter((c) => c.url.endsWith("/v3/workspaces")).length, 1);
});

test("a private or personal message is not posted when ingest is on", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  const env = { HONCHO_INGEST: "1", HONCHO_API_KEY: "hk-test" };
  const state = createHonchoState();
  const dm = ingestIfEnabled(env, pub({ channel_type: "im", channel: "D1" }), { personalRe, fetchImpl, state });
  const personal = ingestIfEnabled(env, pub({ text: "what is the home address" }), { personalRe, fetchImpl, state });
  assert.equal(dm, null);
  assert.equal(personal, null);
  assert.equal(calls, 0);
});

test("send failure is logged and does not reject", async () => {
  const logs = [];
  const fetchImpl = async () => new Response("nope", { status: 500 });
  const task = ingestIfEnabled(
    { HONCHO_INGEST: "1", HONCHO_API_KEY: "hk-test" },
    pub(),
    { personalRe, fetchImpl, state: createHonchoState(), log: (...a) => logs.push(a.join(" ")) },
  );
  await task;
  assert.match(logs.join("\n"), /honcho ingest failed/);
  assert.equal(logs.join("\n").includes("hk-test"), false);
});

test("backfill replays public lines in ts order and dry-run does not POST", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "honcho-log-"));
  fs.writeFileSync(path.join(dir, "2026-01-02.jsonl"), [
    JSON.stringify({ channel: "C1", channel_type: "channel", ts: "1710000003.2", user: "U2", text: "later note" }),
    JSON.stringify({ channel: "D9", channel_type: "im", ts: "1710000000.1", user: "U9", text: "dm secret" }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "2026-01-01.jsonl"), [
    JSON.stringify({ channel: "C1", channel_type: "channel", ts: "1710000001.1", user: "U1", text: "first note", user_display_name: "Ada" }),
    JSON.stringify({ channel: "C1", channel_type: "channel", ts: "1710000002.1", user: "U1", text: "my home address is 1 Main Street" }),
    JSON.stringify({ channel: "C1", channel_type: "channel", ts: "1710000004.1", user: "U3", text: "use xoxb-aaaa-bbbb" }),
    "{not json",
  ].join("\n") + "\n");

  let calls = 0;
  const dry = await backfillLogs({
    dir,
    env: { PERSONAL_NAMES: "" },
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(calls, 0);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.accepted.map((r) => r.ts), ["1710000001.1", "1710000003.2"]);
  assert.equal(dry.accepted[0].content, "Ada: first note");
  assert.equal(dry.accepted[0].sessionId, "channel-C1");
  assert.equal(dry.skipped["not-public"], 1);
  assert.equal(dry.skipped.personal, 1);
  assert.equal(dry.skipped.secret, 1);
  assert.equal(dry.skipped["bad-json"], 1);

  const posted = [];
  const wrote = await backfillLogs({
    dir,
    write: true,
    env: { HONCHO_API_KEY: "hk-test", HONCHO_INGEST: "0" },
    fetchImpl: async (url, opts = {}) => {
      posted.push(String(url));
      assert.equal(opts.headers.Authorization, "Bearer hk-test");
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(wrote.wrote, 2);
  assert.equal(posted.some((u) => u.endsWith("/messages")), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

function slackJson(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("backfill does not treat bare C ids as public and maps dinky to OWN_USER_ID", async () => {
  const entries = [
    { channel: "C0CF63G4CMA", ts: "1710000001.1", user: "U1", text: "group dm note" },
    { channel: "C0CEMRX1Z0E", ts: "1710000001.2", user: "U1", text: "private note" },
    { channel: "CPUB", ts: "1710000001.3", user: "dinky", text: "shipped the notes" },
    { channel: "CPUB", ts: "1710000001.4", user: "U2", text: "human note" },
    { channel: "C0CF63G4CMA", ts: "1710000001.5", user: "U2", text: "same mpim again" },
    { channel: "CUNKNOWN", ts: "1710000001.6", user: "jason", text: "name is not an id" },
  ];
  const info = {
    C0CF63G4CMA: { is_mpim: true },
    C0CEMRX1Z0E: { is_private: true, is_group: true },
    CPUB: { is_channel: true },
  };
  let infoCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("conversations.info")) {
      infoCalls += 1;
      const channel = new URL(u).searchParams.get("channel");
      const channelObj = info[channel];
      if (!channelObj) return slackJson({ ok: false, error: "missing_scope" });
      return slackJson({ ok: true, channel: channelObj });
    }
    return slackJson({ ok: true });
  };
  const classified = await backfillLogs({
    entries,
    env: { SLACK_BOT_TOKEN: "xoxb-test", OWN_USER_ID: "UBOTDINKY", HONCHO_INGEST: "0" },
    fetchImpl,
  });
  assert.equal(classified.dryRun, true);
  assert.deepEqual(classified.accepted.map((row) => row.peerId), ["UBOTDINKY", "U2"]);
  assert.equal(classified.accepted.every((row) => row.peerId !== "dinky"), true);
  assert.equal(classified.accepted[0].content, "dinky: shipped the notes");
  assert.equal(classified.accepted[0].channel, "CPUB");
  assert.equal(classified.skipped["not-public"], 3);
  assert.equal(classified.skipped["needs-channel-type"], 1);
  assert.equal(infoCalls, 4);

  let slackCalls = 0;
  const allowlisted = await backfillLogs({
    entries,
    env: { HONCHO_CHANNEL_IDS: "CPUB", OWN_USER_ID: "UBOTDINKY", HONCHO_INGEST: "0", SLACK_BOT_TOKEN: "xoxb-test" },
    fetchImpl: async (url) => {
      if (String(url).includes("slack.com")) slackCalls += 1;
      return slackJson({ ok: false, error: "missing_scope" });
    },
  });
  assert.equal(slackCalls, 0);
  assert.deepEqual(allowlisted.accepted.map((row) => [row.channel, row.peerId]), [
    ["CPUB", "UBOTDINKY"],
    ["CPUB", "U2"],
  ]);
  assert.ok(allowlisted.skipped["not-allowlisted"] >= 3);

  const viaAuth = await backfillLogs({
    entries: [{ channel: "CPUB", channel_type: "channel", ts: "1710000002.1", user: "Dinky", text: "auth mapped reply" }],
    env: { SLACK_BOT_TOKEN: "xoxb-test", BOT_NAME: "Dinky", HONCHO_INGEST: "0" },
    fetchImpl: async (url) => {
      if (String(url).includes("auth.test")) return slackJson({ ok: true, user_id: "UBOTAUTH", user: "dinky", bot_id: "BBOT" });
      return slackJson({ ok: false, error: "missing_scope" });
    },
  });
  assert.equal(viaAuth.accepted.length, 1);
  assert.equal(viaAuth.accepted[0].peerId, "UBOTAUTH");
  assert.notEqual(viaAuth.accepted[0].peerId, "dinky");
  assert.notEqual(viaAuth.accepted[0].peerId, "Dinky");
});

test("socket and worker wire ingest off the wake path", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const socket = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "cloudflare-relay/src/index.js"), "utf8");
  assert.match(socket, /function fireHonchoIngest/);
  assert.equal(socket.includes("await fireHonchoIngest"), false);
  assert.match(socket, /fireHonchoIngest\(event,/);
  assert.match(socket, /void processInbound/);
  assert.match(worker, /scheduleHoncho\(env, c, e\)/);
  assert.match(worker, /if \(honchoTask\) ctx\.waitUntil\(honchoTask\)/);
  assert.equal(worker.slice(worker.indexOf("async function wakeGrok"), worker.indexOf("async function wakeGrok") + 800).includes("honcho"), false);
  // sendIngest is referenced so a future edit that drops the export fails this file's import.
  assert.equal(typeof sendIngest, "function");
});
