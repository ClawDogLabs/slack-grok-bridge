import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestIfEnabled, resolveIngestChannel, decideIngest, materialize, fetchWakeContext, archiveChannelsOf, archiveSessionOf } from "../src/honcho.js";

const PS = JSON.stringify({ "channel-CPLACEHOLDER1": ["CPLACEHOLDER1"] });
const ALLOW = "CPLACEHOLDER2,CPLACEHOLDER1";

test("private room ingests only to its own channel session with private metadata", async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push([String(url), init?.body ? JSON.parse(init.body) : null]);
    return new Response("{}", { status: 200 });
  };
  const env = {
    HONCHO_INGEST: "1",
    HONCHO_API_KEY: "k",
    HONCHO_API_BASE: "https://h.test",
    HONCHO_CHANNEL_IDS: ALLOW,
    HONCHO_PRIVATE_SESSIONS: PS,
  };
  await ingestIfEnabled(env, {
    type: "message",
    channel: "CPLACEHOLDER1",
    channel_type: "group",
    user: "U1",
    text: "garment sleeve hook idea",
    ts: "1700000000.000100",
  }, { fetchImpl, log() {} });
  assert.ok(posts.length > 0);
  for (const [u] of posts) if (u.includes("/sessions/")) assert.match(u, /channel-CPLACEHOLDER1/);
  const msg = posts.find(([u]) => u.endsWith("/messages"));
  assert.equal(msg[1].messages[0].metadata.private, true);
  const sess = posts.find(([u, b]) => u.endsWith("/sessions") && b?.id);
  if (sess) assert.equal(sess[1].metadata.private, true);
});

test("private channel not in the map, group DMs, and DMs stay skipped", async () => {
  const pc = new Set(["CPLACEHOLDER1"]);
  const allow = new Set(["CPLACEHOLDER1", "C0OTHER"]);
  assert.equal((await resolveIngestChannel({ channel: "C0OTHER", channel_type: "group" }, { allowlist: allow, privateChannels: pc })).ok, false);
  assert.equal((await resolveIngestChannel({ channel: "CPLACEHOLDER1", channel_type: "mpim" }, { allowlist: allow, privateChannels: pc })).ok, false);
  assert.equal((await resolveIngestChannel({ channel: "CPLACEHOLDER1", channel_type: "group" }, { allowlist: new Set(), privateChannels: pc })).ok, false);
  assert.equal(decideIngest({ type: "message", channel: "CPLACEHOLDER1", channel_type: "group", user: "U1", text: "x", ts: "1" }).ok, false);
  const r = await resolveIngestChannel({ channel: "CPLACEHOLDER1", channel_type: "group" }, { allowlist: allow, privateChannels: pc });
  assert.equal(r.ok, true);
  const d = decideIngest({ ...r.event, type: "message", user: "U1", text: "x", ts: "1" });
  assert.equal(d.sessionId, "channel-CPLACEHOLDER1");
  assert.equal(d.private, true);
  assert.equal((await materialize(d)).metadata.private, true);
});

test("archive channel defaults are placeholders and a public wake does not attach them", async () => {
  assert.deepEqual([...archiveChannelsOf({})], ["CPLACEHOLDER1"]);
  assert.equal(archiveSessionOf({}), "archive-private");
  const urls = [];
  const env = {
    HONCHO_API_KEY: "k",
    HONCHO_WORKSPACE_ID: "example-workspace",
    HONCHO_ARCHIVE_SESSION: "archive-private",
    HONCHO_ARCHIVE_CHANNEL_IDS: "CPLACEHOLDER1",
  };
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ summary: "s", peer_representation: "FACT", peer_card: ["card"], messages: [{ content: "x" }] }), { status: 200 });
  };
  const pub = await fetchWakeContext(env, { channel: "CPLACEHOLDER2", user: "U1", channelType: "channel" }, { fetchImpl });
  assert.equal(pub.scope, "public");
  assert.equal(pub.peer_card, null);
  assert.equal(pub.archive, undefined);
  assert.match(urls[0], /limit_to_session=true/);
  assert.equal(urls.some((u) => u.includes("archive-private")), false);
  const room = await fetchWakeContext(env, { channel: "CPLACEHOLDER1", user: "U1" }, { fetchImpl });
  assert.equal(room.scope, "private");
  assert.equal(room.archive.sessionId, "archive-private");
  assert.equal(room.playbooks.sessionId, "privroom-playbooks");
  assert.equal(urls.some((u) => u.includes("limit_to_session")), true);
  const privateUrls = urls.filter((u) => u.includes("channel-CPLACEHOLDER1") || u.includes("archive-private") || u.includes("privroom-playbooks"));
  assert.equal(privateUrls.some((u) => u.includes("limit_to_session")), false);
});

test("bad HONCHO_PRIVATE_SESSIONS JSON attaches no private sessions", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ summary: "s", messages: [] }), { status: 200 });
  };
  const r = await fetchWakeContext(
    { HONCHO_API_KEY: "k", HONCHO_PRIVATE_SESSIONS: "{bad" },
    { channel: "CPLACEHOLDER1", user: "U1" },
    { fetchImpl },
  );
  assert.equal(urls.length, 1);
  assert.equal(r.archive, undefined);
});
