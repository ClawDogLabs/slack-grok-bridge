// Tag-only follow-ups. node:test runs cases concurrently and they share global fetch, so run() is queued.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { slackSignature, isMentionOnly, priorEligible, mergePriorText, PRIOR_WINDOW_SECONDS } from "../src/index.js";

const SECRET = "sec";
const ROOM = "CPLACEHOLDER4";
const ME = "UPLACEHOLDER6";
const ASKER = "UPLACEHOLDER9";
const OTHER = "UPLACEHOLDER7";

let calls = [];
let history = null; // { ok, messages } | "throw" | null
function installFetch() {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    let body = null;
    if (init?.body) { try { body = JSON.parse(init.body); } catch { body = String(init.body); } }
    calls.push({ url: u, body });
    if (u.includes("conversations.history") || u.includes("conversations.replies")) {
      if (history === "throw") throw new Error("network down");
      return new Response(JSON.stringify(history || { ok: false, error: "missing_scope" }));
    }
    if (u.includes("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "555.1" }));
    if (u.startsWith("https://grok.test")) return new Response("ok");
    return new Response(JSON.stringify({ ok: true, user: { id: "U", profile: {} } }));
  };
  return () => { globalThis.fetch = prev; };
}
const env = () => ({
  SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: "xoxb-test", GROK_WEBHOOK_URL: "https://grok.test/hook",
  OWN_USER_ID: ME, OWN_BOT_ID: "BPLACEHOLDER0", HONCHO_READ: "0", HONCHO_INGEST: "0", SILENT_RECORD: "0",
});
async function slackEvent(event) {
  const raw = JSON.stringify({ type: "event_callback", event_id: "Ev" + Math.random(), event });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await slackSignature(SECRET, ts, raw);
  const tasks = [];
  await worker.fetch(new Request("https://relay.test/slack/events", {
    method: "POST", body: raw, headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
  }), env(), { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
}
const wakes = () => calls.filter((c) => c.url.startsWith("https://grok.test")).map((c) => c.body);
const lookups = () => calls.filter((c) => /conversations\.(history|replies)/.test(c.url)).map((c) => new URL(c.url));
const tagOnly = (extra = {}) => ({ type: "app_mention", channel: ROOM, channel_type: "channel", user: ASKER, text: `<@${ME}> `, ts: "1000.500000", ...extra });

let chain = Promise.resolve();
function run(evt, hist) {
  const job = chain.then(async () => {
    const restore = installFetch();
    try { calls = []; history = hist; await slackEvent(evt); } finally { restore(); }
    assert.equal(wakes().length, 1);
    return wakes()[0];
  });
  chain = job.then(() => {}, () => {});
  return job;
}

test("mention-only + recent same-user prior is merged", async () => {
  const w = await run(tagOnly(), { ok: true, messages: [{ type: "message", user: ASKER, text: "Can you see untagged follow-ups?", ts: "977.400000" }] });
  assert.equal(w.kind, "app_mention");
  assert.equal(w.slack.prior_text, "Can you see untagged follow-ups?");
  assert.equal(w.slack.prior_ts, "977.400000");
  assert.equal(w.slack.original_text, `<@${ME}> `);
  assert.equal(w.slack.text, `[prior message from same user]: Can you see untagged follow-ups?\n<@${ME}>`);
  assert.equal(w.slack.ts, "1000.500000");
  const [q] = lookups();
  assert.equal(q.pathname, "/api/conversations.history");
  assert.equal(q.searchParams.get("latest"), "1000.500000");
  assert.equal(q.searchParams.get("inclusive"), "false");
  assert.equal(q.searchParams.get("channel"), ROOM);
});

test("prior older than 60s is not merged", async () => {
  const w = await run(tagOnly(), { ok: true, messages: [{ type: "message", user: ASKER, text: "old q", ts: "930.000000" }] });
  assert.equal(w.slack.prior_text, undefined);
  assert.equal(w.slack.text, `<@${ME}> `);
});

test("prior from a different user is not merged", async () => {
  const w = await run(tagOnly(), { ok: true, messages: [{ type: "message", user: OTHER, text: "someone else", ts: "990.000000" }] });
  assert.equal(w.slack.prior_text, undefined);
  assert.equal(w.slack.text, `<@${ME}> `);
});

test("bot message as newest prior is not merged (even if an older human one qualifies)", async () => {
  const w = await run(tagOnly(), { ok: true, messages: [
    { type: "message", user: ASKER, bot_id: "BX", text: "bot says", ts: "995.000000" },
    { type: "message", user: ASKER, text: "human q", ts: "990.000000" },
  ] });
  assert.equal(w.slack.prior_text, undefined);
  const w2 = await run(tagOnly(), { ok: true, messages: [{ type: "message", subtype: "bot_message", user: ASKER, text: "x", ts: "995.000000" }] });
  assert.equal(w2.slack.prior_text, undefined);
});

test("in-thread tag-only uses conversations.replies and merges a same-thread prior", async () => {
  const evt = tagOnly({ thread_ts: "900.000000", ts: "1000.500000" });
  const w = await run(evt, { ok: true, messages: [
    { type: "message", user: OTHER, text: "root", ts: "900.000000", thread_ts: "900.000000" },
    { type: "message", user: ASKER, text: "follow-up question?", ts: "990.000000", thread_ts: "900.000000" },
  ] });
  assert.equal(w.slack.prior_text, "follow-up question?");
  const [q] = lookups();
  assert.equal(q.pathname, "/api/conversations.replies");
  assert.equal(q.searchParams.get("ts"), "900.000000");
  assert.equal(q.searchParams.get("latest"), "1000.500000");
  assert.equal(q.searchParams.get("inclusive"), "false");
});

test("API error / throw falls back to current behavior", async () => {
  const w = await run(tagOnly(), { ok: false, error: "missing_scope" });
  assert.equal(w.slack.text, `<@${ME}> `);
  assert.equal(w.slack.prior_text, undefined);
  const w2 = await run(tagOnly(), "throw");
  assert.equal(w2.slack.text, `<@${ME}> `);
  assert.equal(w2.slack.prior_text, undefined);
});

test("mention with real text does no lookup", async () => {
  const w = await run(tagOnly({ text: `<@${ME}> what is up?` }), { ok: true, messages: [{ user: ASKER, text: "x", ts: "999.000000" }] });
  assert.equal(lookups().length, 0);
  assert.equal(w.slack.text, `<@${ME}> what is up?`);
});

test("pure helpers", () => {
  assert.equal(PRIOR_WINDOW_SECONDS, 60);
  assert.equal(isMentionOnly(`<@${ME}> `, ME), true);
  assert.equal(isMentionOnly(`<@${ME}> <@UPLACEHOLDER2>`, ME), true);
  assert.equal(isMentionOnly(`<@${ME}> hi`, ME), false);
  assert.equal(isMentionOnly(`<@UPLACEHOLDER2>`, ME), false);
  const e = { user: ASKER, ts: "1000.0" };
  assert.equal(priorEligible({ user: ASKER, text: "q", ts: "950.0" }, e), true);
  assert.equal(priorEligible({ user: ASKER, text: "q", ts: "950.0", subtype: "file_share" }, e), true);
  assert.equal(priorEligible({ user: ASKER, text: "q", ts: "950.0", subtype: "channel_join" }, e), false);
  assert.equal(priorEligible({ user: ASKER, text: "q", ts: "950.0", thread_ts: "800.0" }, e), false);
  assert.equal(priorEligible({ user: ASKER, text: `<@${ME}>`, ts: "950.0" }, e), false);
  assert.equal(mergePriorText("<@U1> ", { text: "q" }), "[prior message from same user]: q\n<@U1>");
});
