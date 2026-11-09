import { test } from "node:test";
import assert from "node:assert/strict";
import worker, {
  assistantGreetingOf,
  assistantPromptsOf,
  routeSurface,
  slackSignature,
  suggestedPromptsArgs,
  viewedContextOf,
} from "../src/index.js";

const SECRET = "sec";
const BOT = "UPLACEHOLDER6";
const DM = "DPLACEHOLDER1";
const VIEW = "CPLACEHOLDER9";
const THREAD = "200.1";

const kv = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
};
const baseEnv = (store, extra = {}) => ({
  SLACK_SIGNING_SECRET: SECRET,
  SLACK_BOT_TOKEN: "t",
  GROK_WEBHOOK_URL: "https://grok.test/hook",
  OWN_USER_ID: BOT,
  OWN_BOT_ID: "BPLACEHOLDER5",
  BRIDGE_SOURCE: "slack-bot-bridge",
  PRIVROOM_STATE: store,
  HONCHO_READ: "0",
  HONCHO_INGEST: "0",
  HOLD_ACK: "false",
  ...extra,
});

let calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, body });
  if (u.startsWith("https://grok.test")) return new Response("ok");
  if (u.includes("users.info")) return new Response(JSON.stringify({ ok: true, user: { id: "UHUMAN", name: "ada", profile: { display_name: "Ada" } } }));
  return new Response(JSON.stringify({ ok: true, ts: "9.9" }));
};

async function send(env, event, extra = {}) {
  const raw = JSON.stringify({ type: "event_callback", event_id: "Ev" + Math.random(), event, ...extra });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await slackSignature(SECRET, ts, raw);
  const tasks = [];
  const res = await worker.fetch(new Request("https://relay.test/slack/events", {
    method: "POST", body: raw, headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
  }), env, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
  return res;
}

const started = (extra = {}) => ({
  type: "assistant_thread_started",
  assistant_thread: {
    user_id: "UHUMAN",
    channel_id: DM,
    thread_ts: THREAD,
    context: { channel_id: VIEW, team_id: "TPLACEHOLDER1", enterprise_id: "EPLACEHOLDER1" },
    ...extra,
  },
});

test("viewed context keeps channel fields and agent entities, and drops unknown keys", () => {
  assert.deepEqual(viewedContextOf({ channel_id: VIEW, team_id: "TPLACEHOLDER1", token: "nope" }), {
    channel_id: VIEW,
    team_id: "TPLACEHOLDER1",
  });
  const entities = viewedContextOf({
    entities: [{ type: "slack#/types/channel_id", value: VIEW, team_id: "TPLACEHOLDER1", secret: "nope" }],
  });
  assert.equal(entities.channel_id, VIEW);
  assert.equal(entities.entities[0].secret, undefined);
  assert.equal(viewedContextOf(null), null);
});

test("suggested prompts omit thread_ts unless opted in, and bad JSON falls back", () => {
  const plain = suggestedPromptsArgs({}, DM, THREAD);
  assert.equal(plain.thread_ts, undefined);
  assert.equal(plain.prompts.length, 2);
  assert.equal(assistantGreetingOf({}), "Hi. Ask a question, or choose a prompt.");
  const legacy = suggestedPromptsArgs({ ASSISTANT_PROMPTS_IN_THREAD: "1" }, DM, THREAD);
  assert.equal(legacy.thread_ts, THREAD);
  const custom = suggestedPromptsArgs({
    ASSISTANT_PROMPTS_TITLE: "Start here",
    ASSISTANT_PROMPTS: JSON.stringify([{ title: "One", message: "Do one thing." }, { title: "", message: "skip" }]),
  }, DM, null);
  assert.deepEqual(custom.prompts, [{ title: "One", message: "Do one thing." }]);
  assert.equal(custom.title, "Start here");
  assert.equal(assistantPromptsOf({ ASSISTANT_PROMPTS: "not-json" })[0].title, "Ask a question");
  assert.equal(assistantGreetingOf({ ASSISTANT_GREETING: "off" }), "");
});

test("assistant_thread_started greets in the thread, sets prompts, stores context, and does not wake", async () => {
  const s = kv(); calls = [];
  const res = await send(baseEnv(s, {
    ASSISTANT_GREETING: "Hello there.",
    ASSISTANT_PROMPTS_TITLE: "Start here",
    ASSISTANT_PROMPTS: JSON.stringify([{ title: "One", message: "Do one thing." }]),
  }), started());
  assert.equal(res.headers.get("X-Relay-Action"), "assistant:assistant_thread_started");
  const post = calls.find((c) => c.url.includes("chat.postMessage"));
  assert.equal(post.body.channel, DM);
  assert.equal(post.body.thread_ts, THREAD);
  assert.equal(post.body.text, "Hello there.");
  const prompts = calls.find((c) => c.url.includes("setSuggestedPrompts"));
  assert.equal(prompts.body.thread_ts, undefined);
  assert.equal(prompts.body.title, "Start here");
  assert.deepEqual(prompts.body.prompts, [{ title: "One", message: "Do one thing." }]);
  assert.equal(calls.some((c) => c.url.startsWith("https://grok.test")), false);
  const saved = JSON.parse(s.m.get(`assistant:${DM}:${THREAD}`));
  assert.equal(saved.context.channel_id, VIEW);
  assert.equal(saved.context.team_id, "TPLACEHOLDER1");
  assert.equal(saved.context.token, undefined);
});

test("context change is stored per thread and does not post or wake", async () => {
  const s = kv(); calls = [];
  const res = await send(baseEnv(s), {
    type: "assistant_thread_context_changed",
    assistant_thread: {
      user_id: "UHUMAN",
      channel_id: DM,
      thread_ts: THREAD,
      context: { channel_id: "CPLACEHOLDER8", team_id: "TPLACEHOLDER2" },
    },
  });
  assert.equal(res.headers.get("X-Relay-Action"), "assistant:assistant_thread_context_changed");
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(s.m.get(`assistant:${DM}:${THREAD}`)).context.channel_id, "CPLACEHOLDER8");
});

test("an assistant-thread DM wakes with thread_ts, context, and a cleared thinking status", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), started());
  calls = [];
  const res = await send(baseEnv(s), {
    type: "message",
    channel_type: "im",
    channel: DM,
    user: "UHUMAN",
    text: "and the rest?",
    ts: "200.5",
    thread_ts: THREAD,
  });
  assert.equal(res.headers.get("X-Relay-Action"), "wake_dm:im");
  const wake = calls.find((c) => c.url.startsWith("https://grok.test"));
  assert.equal(wake.body.reply.thread_ts, THREAD);
  assert.equal(wake.body.reply.reply_broadcast, false);
  assert.equal(wake.body.slack.thread_ts, THREAD);
  assert.equal(wake.body.assistant.thread_ts, THREAD);
  assert.equal(wake.body.assistant.context.channel_id, VIEW);
  assert.equal(wake.body.assistant.context.enterprise_id, "EPLACEHOLDER1");
  assert.equal(wake.body.routing.surface, "assistant_thread");
  assert.equal(wake.body.routing.panel, true);
  assert.equal(wake.body.routing.provenance, "assistant_thread_record");
  assert.equal(wake.body.routing.reply_thread_ts, THREAD);
  assert.equal(wake.body.routing.reply_broadcast, false);
  const statuses = calls.filter((c) => c.url.includes("assistant.threads.setStatus"));
  assert.equal(statuses[0].body.channel_id, DM);
  assert.equal(statuses[0].body.thread_ts, THREAD);
  assert.equal(statuses[0].body.status, "is thinking…");
  assert.ok(Array.isArray(statuses[0].body.loading_messages));
  assert.equal(statuses.at(-1).body.status, "");
  assert.equal(statuses.at(-1).body.thread_ts, THREAD);
  const wakeAt = calls.findIndex((c) => c.url.startsWith("https://grok.test"));
  const clearAt = calls.findLastIndex((c) => c.url.includes("setStatus") && c.body.status === "");
  assert.ok(wakeAt > calls.findIndex((c) => c.url.includes("setStatus") && c.body.status === "is thinking…"));
  assert.ok(clearAt > wakeAt);
  assert.equal(calls.some((c) => c.url.includes("chat.postMessage")), false);
});

test("an ordinary DM stays top-level and does not pick up assistant context", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), started());
  calls = [];
  await send(baseEnv(s), {
    type: "message", channel_type: "im", channel: DM, user: "UHUMAN", text: "hello", ts: "300.1",
  });
  const wake = calls.find((c) => c.url.startsWith("https://grok.test"));
  assert.equal(wake.body.reply.thread_ts, null);
  assert.equal(wake.body.assistant, undefined);
  assert.equal(wake.body.slack.thread_ts, undefined);
  assert.equal(wake.body.routing.surface, "im");
  assert.equal(wake.body.routing.panel, false);
  assert.equal(wake.body.routing.reply_thread_ts, null);
  assert.equal(wake.body.routing.reply_broadcast, false);
  assert.equal(wake.body.routing.context, null);
});

test("a plain DM thread stays in that thread and is not the panel", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), {
    type: "message", channel_type: "im", channel: DM, user: "UHUMAN", text: "inside", ts: "240.5", thread_ts: "240.1",
  });
  const wake = calls.find((c) => c.url.startsWith("https://grok.test"));
  assert.equal(wake.body.routing.surface, "im_thread");
  assert.equal(wake.body.routing.panel, false);
  assert.equal(wake.body.routing.provenance, "incoming_thread");
  assert.equal(wake.body.routing.reply_thread_ts, "240.1");
  assert.equal(wake.body.reply.thread_ts, "240.1");
  assert.equal(wake.body.routing.reply_broadcast, false);
  assert.equal(wake.body.routing.context, null);
  assert.equal(wake.body.assistant, undefined);
});

test("a bot message in an assistant thread does not wake", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), started());
  calls = [];
  await send(baseEnv(s), {
    type: "message",
    channel_type: "im",
    channel: DM,
    user: BOT,
    bot_id: "BPLACEHOLDER5",
    subtype: "bot_message",
    text: "Hello there.",
    ts: "200.2",
    thread_ts: THREAD,
  });
  assert.equal(calls.some((c) => c.url.startsWith("https://grok.test")), false);
  assert.equal(calls.some((c) => c.url.includes("setStatus")), false);
});

test("app_context_changed does not mark a later DM thread as the panel", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), {
    type: "app_context_changed",
    context: { entities: [{ type: "slack#/types/channel_id", value: "CPLACEHOLDER7", team_id: "TPLACEHOLDER3" }] },
  }, { authorizations: [{ user_id: "UHUMAN", is_bot: false }] });
  assert.equal(calls.length, 0);
  assert.equal([...s.m.keys()].some((k) => String(k).includes("UHUMAN")), false);
  calls = [];
  await send(baseEnv(s), {
    type: "message", channel_type: "im", channel: DM, user: "UHUMAN", text: "what about this channel?", ts: "210.5", thread_ts: "210.1",
  });
  const wake = calls.find((c) => c.url.startsWith("https://grok.test"));
  assert.equal(wake.body.routing.surface, "im_thread");
  assert.equal(wake.body.routing.panel, false);
  assert.equal(wake.body.routing.context, null);
  assert.equal(wake.body.routing.reply_broadcast, false);
  assert.equal(wake.body.assistant, undefined);
  assert.equal(s.m.has(`assistant:${DM}:210.1`), false);
});

test("a stale per-user record and an unmarked thread record do not become the panel", async () => {
  const s = kv(); calls = [];
  s.m.set("assistant-user:UHUMAN", JSON.stringify({ context: { channel_id: "CPLACEHOLDER7" }, user_id: "UHUMAN" }));
  s.m.set(`assistant:${DM}:210.1`, JSON.stringify({
    context: { channel_id: "CPLACEHOLDER8" }, channel_id: DM, thread_ts: "210.1",
  }));
  await send(baseEnv(s), {
    type: "message", channel_type: "im", channel: DM, user: "UHUMAN", text: "plain thread", ts: "210.5", thread_ts: "210.1",
  });
  const wake = calls.find((c) => c.url.startsWith("https://grok.test"));
  assert.equal(wake.body.routing.surface, "im_thread");
  assert.equal(wake.body.routing.panel, false);
  assert.equal(wake.body.routing.context, null);
  assert.equal(wake.body.assistant, undefined);
  assert.equal(JSON.stringify(wake.body).includes("CPLACEHOLDER7"), false);
  assert.equal(JSON.stringify(wake.body).includes("CPLACEHOLDER8"), false);
});

test("context changed before the start still names that thread only", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), {
    type: "assistant_thread_context_changed",
    assistant_thread: { user_id: "UHUMAN", channel_id: DM, thread_ts: THREAD, context: { channel_id: "CPLACEHOLDER8" } },
  });
  await send(baseEnv(s), {
    type: "assistant_thread_started",
    assistant_thread: { user_id: "UHUMAN", channel_id: DM, thread_ts: THREAD },
  });
  assert.equal(calls.filter((c) => c.url.includes("chat.postMessage")).length, 1);
  calls = [];
  await send(baseEnv(s), {
    type: "message", channel_type: "im", channel: DM, user: "UHUMAN", text: "in the panel", ts: "200.5", thread_ts: THREAD,
  });
  await send(baseEnv(s), {
    type: "message", channel_type: "im", channel: DM, user: "UHUMAN", text: "other thread", ts: "211.5", thread_ts: "211.1",
  });
  const wakes = calls.filter((c) => c.url.startsWith("https://grok.test"));
  assert.equal(wakes[0].body.routing.surface, "assistant_thread");
  assert.equal(wakes[0].body.routing.context.channel_id, "CPLACEHOLDER8");
  assert.equal(wakes[0].body.routing.reply_broadcast, false);
  assert.equal(wakes[1].body.routing.surface, "im_thread");
  assert.equal(wakes[1].body.routing.context, null);
  assert.equal(wakes[1].body.assistant, undefined);
});

test("a repeated assistant_thread_started greets once", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), started());
  await send(baseEnv(s), started());
  assert.equal(calls.filter((c) => c.url.includes("chat.postMessage")).length, 1);
});

test("a top-level agent message with context is still a main DM", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), {
    type: "message",
    channel_type: "im",
    channel: DM,
    user: "UHUMAN",
    text: "summarize this",
    ts: "220.1",
    app_context: { entities: [{ type: "slack#/types/channel_id", value: VIEW, team_id: "TPLACEHOLDER1" }] },
  });
  const wake = calls.find((c) => c.url.startsWith("https://grok.test"));
  assert.equal(wake.body.routing.surface, "im");
  assert.equal(wake.body.routing.panel, false);
  assert.equal(wake.body.routing.provenance, "top_level");
  assert.equal(wake.body.routing.reply_thread_ts, null);
  assert.equal(wake.body.routing.reply_broadcast, false);
  assert.equal(wake.body.routing.viewed.channel_id, VIEW);
  assert.equal(wake.body.routing.viewed_source, "event");
  assert.equal(wake.body.reply.thread_ts, null);
  assert.equal(wake.body.assistant, undefined);
  assert.equal(s.m.has(`assistant:${DM}:220.1`), false);
});

test("an assistant_thread_started without a thread id does not invent one", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), started({ thread_ts: undefined }));
  assert.equal(calls.length, 0);
  assert.equal(s.m.size, 0);
});

test("messages-tab open sets prompts and greets once; the home tab does neither", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s), { type: "app_home_opened", user: "UHUMAN", channel: DM, tab: "home" });
  assert.equal(calls.length, 0);
  await send(baseEnv(s), { type: "app_home_opened", user: "UHUMAN", channel: DM, tab: "messages" });
  await send(baseEnv(s), { type: "app_home_opened", user: "UHUMAN", channel: DM, tab: "messages" });
  const posts = calls.filter((c) => c.url.includes("chat.postMessage"));
  const prompts = calls.filter((c) => c.url.includes("setSuggestedPrompts"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.thread_ts, undefined);
  assert.equal(posts[0].body.channel, DM);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].body.thread_ts, undefined);
  assert.equal(calls.some((c) => c.url.startsWith("https://grok.test")), false);
});

test("a muted assistant DM does not greet, and the panel switch disables it", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s, { SILENT_CHANNEL_IDS: DM }), started());
  assert.equal(calls.length, 0);
  assert.equal(s.m.has(`assistant:${DM}:${THREAD}`), false);
  calls = [];
  await send(baseEnv(s, { ASSISTANT_PANEL: "0" }), started());
  assert.equal(calls.length, 0);
  calls = [];
  await send(baseEnv(s, { ASSISTANT_PANEL: "0" }), {
    type: "message", channel_type: "im", channel: DM, user: "UHUMAN", text: "still here", ts: "200.8", thread_ts: THREAD,
  });
  const wake = calls.find((c) => c.url.startsWith("https://grok.test"));
  assert.equal(wake.body.reply.thread_ts, THREAD);
  assert.equal(wake.body.assistant, undefined);
});

test("channel and group-DM routes do not borrow the 1:1 rule", async () => {
  const env = {
    OWN_USER_ID: BOT,
    PRIVROOM_BOTS: JSON.stringify([{ name: "BotB", userId: "UPLACEHOLDER2", botId: "BPLACEHOLDER1" }]),
  };
  const first = await routeSurface(env, {
    type: "app_mention", channel: "CPLACEHOLDER4", channel_type: "channel", user: "UHUMAN", text: `<@${BOT}> hi`, ts: "1.1",
  });
  assert.equal(first.surface, "channel");
  assert.equal(first.reply_broadcast, true);
  assert.equal(first.reply_thread_ts, "1.1");
  const follow = await routeSurface(env, {
    type: "message", channel: "CPLACEHOLDER4", channel_type: "channel", user: "UHUMAN", text: `<@${BOT}> again`, ts: "1.5", thread_ts: "1.1",
  });
  assert.equal(follow.reply_broadcast, false);
  assert.equal(follow.reply_thread_ts, "1.1");
  const multi = await routeSurface(env, {
    type: "app_mention", channel: "CPLACEHOLDER4", channel_type: "channel", user: "UHUMAN", text: `<@${BOT}> <@UPLACEHOLDER2> both`, ts: "2.1",
  });
  assert.equal(multi.reply_broadcast, false);
  const mpim = await routeSurface(env, {
    type: "message", channel: "GPLACEHOLDER1", channel_type: "mpim", user: "UHUMAN", text: "hi", ts: "3.1",
  });
  assert.equal(mpim.surface, "mpim");
  assert.equal(mpim.reply_thread_ts, null);
  assert.equal(mpim.reply_broadcast, false);
});

test("legacy containers can pin prompts to the assistant thread", async () => {
  const s = kv(); calls = [];
  await send(baseEnv(s, { ASSISTANT_PROMPTS_IN_THREAD: "1" }), started());
  const prompts = calls.find((c) => c.url.includes("setSuggestedPrompts"));
  assert.equal(prompts.body.thread_ts, THREAD);
});
