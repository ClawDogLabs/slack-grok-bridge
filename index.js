/**
 * Slack Socket Mode → Grok inbound webhook bridge (template).
 * Listens for app mentions / DMs and POSTs a short payload to a Grok inbound webhook.
 *
 * Required env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, GROK_WEBHOOK_URL
 * Optional: SLACK_SIGNING_SECRET, GROK_WEBHOOK_SECRET, BRIDGE_SOURCE,
 *           THINKING_TIMEOUT_MS (default 45000),
 *           ACK_REACTION (default "white_check_mark"; "off" disables; missing custom emoji
 *           falls back to white_check_mark; missing reactions:write is logged),
 *           HOLD_ACK (default "false" — opt-in text hold-ack; the reaction is the default ack),
 *           HOLD_ACK_BROADCAST (default "true"), OWNER_DISPLAY_NAME (default "the owner"),
 *           ALLOW_BOT_IDS / ALLOW_BOT_USER_IDS (comma-separated; empty = ignore bot mentions),
 *           CLIENT_PING_TIMEOUT_MS (default 15000), SERVER_PING_TIMEOUT_MS (default 60000),
 *           WATCHDOG_MAX_UNHEALTHY_MS (default 120000),
 *           HONCHO_INGEST (default off; "1" writes public-channel messages to Honcho),
 *           HONCHO_API_KEY, HONCHO_WORKSPACE_ID (default slack-workspace),
 *           SILENT_CHANNEL_IDS (comma-separated; those channels get no reaction,
 *           thinking status, hold-ack, wake, or Honcho write. Does not record.)
 *
 * Reliability: Socket Mode only works while this process is running AND its host is awake.
 * A connection watchdog exits(1) when the socket stays unhealthy, so supervise.sh (started by
 * start.sh) restarts node. On hosts that sleep/freeze when idle, use the HTTP relay in
 * cloudflare-relay/ instead (see README "Lessons learned").
 *
 * Ack model: Bolt acks a Socket Mode event when this listener's Promise settles.
 * Never await the Grok webhook (or other slow work) before returning - fire it
 * after a fast thinking status so Slack does not retry (3s) and duplicate wakes.
 *
 * After the listener returns, react to the message (reactions:write). A text
 * hold-ack is posted only when HOLD_ACK=true. Personal/family asks get a stronger
 * privacy hold message. Replies this process posts use the threading rule:
 * plain in DMs/group DMs unless the message is already in a thread; thread +
 * reply_broadcast in channels. The same placement is sent as `reply` on the webhook.
 * Keep ackEmoji / replyFields in sync with cloudflare-relay/src/index.js.
 */
const { App, SocketModeReceiver } = require("@slack/bolt");

const required = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "GROK_WEBHOOK_URL"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing ${key}. Copy .env.example to .env and fill tokens (or set env vars).`);
    process.exit(1);
  }
}

const BRIDGE_SOURCE = process.env.BRIDGE_SOURCE || "slack-grok-bridge";
const HOLD_ACK = String(process.env.HOLD_ACK || "false").toLowerCase() !== "false";
const OWNER_DISPLAY_NAME = process.env.OWNER_DISPLAY_NAME || "the owner";
const HOLD_ACK_BROADCAST = String(process.env.HOLD_ACK_BROADCAST || "true").toLowerCase() !== "false";
const THINKING_TIMEOUT_MS = Number(process.env.THINKING_TIMEOUT_MS || 45000);
const DEFAULT_ACK_EMOJI = "white_check_mark";

function ackEmoji(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_ACK_EMOJI;
  const name = String(value).trim().replace(/^:+|:+$/g, "");
  if (!name || /^(off|false|none|0)$/i.test(name)) return null;
  return name;
}
const ACK_REACTION = ackEmoji(process.env.ACK_REACTION);

function replyFields(event) {
  const channel = String(event?.channel || "");
  const ct = event?.channel_type;
  const isDm = ct === "im" || ct === "mpim" || channel.startsWith("D");
  const parent = event?.thread_ts && event.thread_ts !== event?.ts ? event.thread_ts : null;
  if (isDm) return { thread_ts: parent, reply_broadcast: false };
  return { thread_ts: parent || event?.ts || null, reply_broadcast: true };
}

/** Comma-separated Slack bot_ids (B…) and/or bot user ids (U…) allowed to @mention us. Empty = ignore all bots (Slack default). Always ignore our own bot_id. */
function parseIdList(envVal) {
  return new Set(
    String(envVal || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}
const ALLOW_BOT_IDS = parseIdList(process.env.ALLOW_BOT_IDS);
const ALLOW_BOT_USER_IDS = parseIdList(process.env.ALLOW_BOT_USER_IDS);
let ownBotId = null;
let ownUserId = null;

function isAllowedBotMention(event) {
  if (!event.bot_id && event.subtype !== "bot_message") return true; // human
  if (ownBotId && event.bot_id === ownBotId) return false;
  if (ownUserId && event.user === ownUserId) return false;
  if (event.bot_id && ALLOW_BOT_IDS.has(event.bot_id)) return true;
  if (event.user && ALLOW_BOT_USER_IDS.has(event.user)) return true;
  return false;
}

// Socket Mode tuning: the library default clientPingTimeout (5000ms) is very aggressive; any
// brief stall of the host or an egress proxy triggers a reconnect, and the reconnect path can
// wedge with the process still alive. Use more tolerant timeouts (overridable via env).
const CLIENT_PING_TIMEOUT_MS = Number(process.env.CLIENT_PING_TIMEOUT_MS || 15000);
const SERVER_PING_TIMEOUT_MS = Number(process.env.SERVER_PING_TIMEOUT_MS || 60000);
const WATCHDOG_MAX_UNHEALTHY_MS = Number(process.env.WATCHDOG_MAX_UNHEALTHY_MS || 120000);
const WATCHDOG_CHECK_MS = 15000;
const STARTUP_TIMEOUT_MS = 90000;

const receiver = new SocketModeReceiver({
  appToken: process.env.SLACK_APP_TOKEN,
  clientPingTimeout: CLIENT_PING_TIMEOUT_MS,
  serverPingTimeout: SERVER_PING_TIMEOUT_MS,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ---- Connection watchdog --------------------------------------------------
// Process liveness is not connection health: a wedged reconnect leaves node running but deaf.
// Healthy = the raw websocket is OPEN and Slack has pinged us / sent a message recently.
// If not healthy for WATCHDOG_MAX_UNHEALTHY_MS, exit(1); supervise.sh restarts us.
const ts = () => new Date().toISOString();
const smClient = receiver.client;
let lastActivity = Date.now(); // last server ping/pong, ws message, or 'connected'
let lastHealthyAt = Date.now();
let wasHealthy = null;
const hookedSockets = new WeakSet();
function rawSocket() {
  return smClient?.websocket?.websocket || null; // SlackWebSocket -> ws.WebSocket (Bolt 4 internals)
}
function hookRawSocket() {
  const ws = rawSocket();
  if (ws && !hookedSockets.has(ws)) {
    hookedSockets.add(ws);
    ws.on("ping", () => { lastActivity = Date.now(); });
    ws.on("pong", () => { lastActivity = Date.now(); });
  }
}
smClient.on("ws_message", () => { lastActivity = Date.now(); hookRawSocket(); });
for (const st of ["connecting", "authenticated", "connected", "reconnecting", "disconnecting", "disconnected"]) {
  smClient.on(st, () => {
    if (st === "connected") { lastActivity = Date.now(); hookRawSocket(); }
    console.log(`[${ts()}] socket-mode state: ${st}`);
  });
}
setInterval(() => {
  hookRawSocket();
  const ws = rawSocket();
  const open = !!ws && ws.readyState === 1;
  const fresh = Date.now() - lastActivity < SERVER_PING_TIMEOUT_MS + 15000;
  const healthy = open && fresh;
  const now = Date.now();
  if (healthy) {
    if (wasHealthy === false) console.log(`[${ts()}] watchdog: connection healthy again`);
    lastHealthyAt = now;
  } else {
    if (wasHealthy !== false) {
      console.warn(`[${ts()}] watchdog: connection unhealthy (open=${open}, last activity ${Math.round((now - lastActivity) / 1000)}s ago)`);
    }
    if (now - lastHealthyAt > WATCHDOG_MAX_UNHEALTHY_MS) {
      console.error(`[${ts()}] watchdog: unhealthy for ${Math.round((now - lastHealthyAt) / 1000)}s - exiting so the supervisor restarts the bridge`);
      process.exit(1);
    }
  }
  wasHealthy = healthy;
}, WATCHDOG_CHECK_MS).unref();

const userCache = new Map();
const thinkingTimers = new Map();

const LOADING_MESSAGES = [
  `checking with ${OWNER_DISPLAY_NAME}…`,
  "asking Grok…",
  "almost there…",
];

/**
 * Heuristic only: stronger hold when the ask looks personal / family / schedule.
 * PERSONAL_NAMES lets each owner add their own family/private names via .env
 * (comma-separated) instead of committing them into this shared template.
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const PERSONAL_NAMES = String(process.env.PERSONAL_NAMES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(escapeRegex);
const PERSONAL_BASE_TERMS = [
  "kids?", "child", "daughter", "son", "family", "school", "calendar",
  "schedule", "class(?:es)?", "lessons?", "practice", "activit(?:y|ies)", "sports?",
  "pickup", "carpool", "address", "home", "phone", "email",
  "where (?:is|are)", "what time", "taking",
];
const PERSONAL_RE = new RegExp(
  `\\b(${[...PERSONAL_NAMES, ...PERSONAL_BASE_TERMS].join("|")})\\b`,
  "i"
);

const HOLD_ACK_GENERIC =
  `Got it - checking with ${OWNER_DISPLAY_NAME} and will get back to you.`;
const HOLD_ACK_PERSONAL =
  `That's not on my approved list of things to share publicly. Let me check with ${OWNER_DISPLAY_NAME} and get back to you.`;

async function resolveUser(client, userId) {
  if (!userId) return null;
  if (userCache.has(userId)) return userCache.get(userId);
  try {
    const res = await client.users.info({ user: userId });
    if (!res.ok || !res.user) {
      const fallback = { id: userId };
      userCache.set(userId, fallback);
      return fallback;
    }
    const profile = res.user.profile || {};
    const info = {
      id: userId,
      name: res.user.name || null,
      real_name: res.user.real_name || profile.real_name || null,
      display_name: profile.display_name || null,
      is_bot: !!res.user.is_bot,
    };
    userCache.set(userId, info);
    return info;
  } catch (err) {
    const fallback = { id: userId };
    userCache.set(userId, fallback);
    return fallback;
  }
}

async function wakeGrok(payload) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.GROK_WEBHOOK_SECRET) {
    headers["Authorization"] = `Bearer ${process.env.GROK_WEBHOOK_SECRET}`;
    headers["X-Automation-Key"] = process.env.GROK_WEBHOOK_SECRET;
  }
  const res = await fetch(process.env.GROK_WEBHOOK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Grok webhook ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

async function summarizeEvent(client, event) {
  const userInfo = await resolveUser(client, event.user);
  return {
    type: event.type,
    user: event.user,
    user_name: userInfo?.name || null,
    user_real_name: userInfo?.real_name || null,
    user_display_name: userInfo?.display_name || null,
    channel: event.channel,
    channel_type: event.channel_type,
    ts: event.ts,
    thread_ts: event.thread_ts,
    text: event.text,
    subtype: event.subtype || null,
    files: Array.isArray(event.files)
      ? event.files.map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype, filetype: f.filetype, url_private: f.url_private }))
      : undefined,
  };
}

/** Dedupe: an @mention in a DM/group DM can arrive as both app_mention and message. Wake once per channel:ts. */
const recentWakes = new Map();
function firstWake(channel, msgTs) {
  const key = `${channel}:${msgTs}`;
  const now = Date.now();
  for (const [k, t] of recentWakes) if (now - t > 10 * 60 * 1000) recentWakes.delete(k);
  if (recentWakes.has(key)) return false;
  recentWakes.set(key, now);
  return true;
}

/** Message subtypes that are real user posts (e.g. an image/PDF with a caption). Edits, joins, bot posts are skipped. */
const FORWARD_SUBTYPES = new Set(["file_share"]);
function isUserPost(message) {
  if (message.bot_id) return false;
  if (ownUserId && message.user === ownUserId) return false;
  return !message.subtype || FORWARD_SUBTYPES.has(message.subtype);
}

function threadTsFor(event) {
  return event.thread_ts || event.ts;
}

function thinkingKey(channel, threadTs) {
  return `${channel}:${threadTs}`;
}

function looksPersonal(text) {
  return PERSONAL_RE.test(String(text || ""));
}

/** Keep in sync with eventChannelId / isSilentEvent in cloudflare-relay/src/honcho.js. */
function eventChannelId(event) {
  if (!event || typeof event !== "object") return "";
  for (const value of [event.channel, event.channel_id, event.message?.channel, event.item?.channel, event.previous_message?.channel]) {
    const id = String(value ?? "").trim();
    if (id) return id;
  }
  return "";
}
function isSilentEvent(event) {
  const id = eventChannelId(event);
  if (!id) return false;
  const ids = String(process.env.SILENT_CHANNEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(id);
}

// Same rule as cloudflare-relay/src/honcho.js honchoIngestEnabled. Default off.
function honchoIngestOn() {
  const v = String(process.env.HONCHO_INGEST ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function honchoExtras(client, logger) {
  return {
    logger,
    ownUserId,
    ownBotId,
    personalRe: PERSONAL_RE,
    log: (...args) => {
      if (logger?.info) logger.info(...args);
      else console.log(...args);
    },
    // null on missing_scope / error. A C id is not treated as public.
    lookupChannel: async (channel) => {
      try {
        const info = await client.conversations.info({ channel });
        return info?.channel || null;
      } catch {
        return null;
      }
    },
    resolveDisplay: async (userId) => {
      const info = await resolveUser(client, userId);
      return info?.display_name || info?.real_name || info?.name || null;
    },
  };
}

// Fire-and-forget. Never await this before the Bolt listener returns or inside wakeGrok.
function fireHonchoIngest(event, extras = {}) {
  if (!honchoIngestOn()) return;
  const logger = extras.logger;
  void import("./cloudflare-relay/src/honcho.js")
    .then((m) => m.ingestIfEnabled(process.env, event, extras))
    .catch((err) => {
      const msg = err?.message || err;
      if (logger?.error) logger.error(`[${ts()}] honcho ingest failed`, msg);
      else console.error(`[${ts()}] honcho ingest failed`, msg);
    });
}

async function setThinking(client, channel, threadTs, logger) {
  if (!channel || !threadTs) return;
  try {
    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: threadTs,
      status: "is thinking…",
      loading_messages: LOADING_MESSAGES,
    });
    const key = thinkingKey(channel, threadTs);
    const prev = thinkingTimers.get(key);
    if (prev) clearTimeout(prev);
    thinkingTimers.set(
      key,
      setTimeout(() => {
        thinkingTimers.delete(key);
        void clearThinking(client, channel, threadTs, logger);
      }, THINKING_TIMEOUT_MS)
    );
  } catch (err) {
    logger?.warn?.("assistant.threads.setStatus failed", err?.data?.error || err?.message || err);
  }
}

async function clearThinking(client, channel, threadTs, logger) {
  if (!channel || !threadTs) return;
  const key = thinkingKey(channel, threadTs);
  const prev = thinkingTimers.get(key);
  if (prev) {
    clearTimeout(prev);
    thinkingTimers.delete(key);
  }
  try {
    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: threadTs,
      status: "",
    });
  } catch (err) {
    logger?.warn?.("clear setStatus failed", err?.data?.error || err?.message || err);
  }
}

async function addAckReaction(client, channel, ts, logger) {
  if (!ACK_REACTION || !channel || !ts) return;
  const name = ACK_REACTION;
  try {
    await client.reactions.add({ channel, timestamp: ts, name });
  } catch (err) {
    const error = err?.data?.error || "";
    if (error === "already_reacted") return;
    if (error === "missing_scope") {
      logger?.warn?.("ack reaction skipped: bot token is missing reactions:write (add the scope and reinstall the app)");
      return;
    }
    if ((error === "invalid_name" || error === "emoji_not_found") && name !== DEFAULT_ACK_EMOJI) {
      logger?.warn?.(`ack reaction :${name}: is not available; falling back to :${DEFAULT_ACK_EMOJI}:`);
      try {
        await client.reactions.add({ channel, timestamp: ts, name: DEFAULT_ACK_EMOJI });
      } catch (err2) {
        const error2 = err2?.data?.error || "";
        if (error2 === "missing_scope") {
          logger?.warn?.("ack reaction skipped: bot token is missing reactions:write (add the scope and reinstall the app)");
        } else if (error2 !== "already_reacted") {
          logger?.warn?.("ack reaction fallback failed", error2 || err2?.message || err2);
        }
      }
      return;
    }
    logger?.warn?.("ack reaction failed", error || err?.message || err);
  }
}

let loggedChannelScope = false;
async function enrichChannelType(client, event, logger) {
  const ct = event?.channel_type;
  if (ct === "im" || ct === "mpim" || ct === "channel" || ct === "group") return event;
  if (String(event?.channel || "").startsWith("D")) return { ...event, channel_type: "im" };
  if (!event?.channel) return { ...event, channel_type: "channel" };
  try {
    const info = await client.conversations.info({ channel: event.channel });
    const ch = info?.channel;
    if (!ch) return { ...event, channel_type: "channel" };
    const channel_type = ch.is_im ? "im" : ch.is_mpim ? "mpim" : (ch.is_private || ch.is_group) ? "group" : "channel";
    return { ...event, channel_type };
  } catch (err) {
    const error = err?.data?.error || "";
    if (error === "missing_scope" && !loggedChannelScope) {
      loggedChannelScope = true;
      logger?.warn?.("conversations.info missing scope; treating this @mention as a channel. Add channels:read, groups:read, im:read, or mpim:read to classify group DMs.");
    }
    return { ...event, channel_type: "channel" };
  }
}

async function postHoldAck(client, channel, text, fields, logger) {
  if (!HOLD_ACK || !channel) return;
  const body = looksPersonal(text) ? HOLD_ACK_PERSONAL : HOLD_ACK_GENERIC;
  const payload = { channel, text: body };
  if (fields?.thread_ts) payload.thread_ts = fields.thread_ts;
  if (fields?.reply_broadcast && HOLD_ACK_BROADCAST) payload.reply_broadcast = true;
  try {
    await client.chat.postMessage(payload);
  } catch (err) {
    logger?.warn?.("hold-ack post failed", err?.data?.error || err?.message || err);
  }
}

/**
 * Slow path: react, resolve user, wake Grok. Runs AFTER the Bolt listener returns (ack).
 * Clear thinking as soon as the webhook is accepted. The text hold-ack is opt-in.
 */
async function processInbound({ kind, event, client, logger, sayOnFail }) {
  if (isSilentEvent(event)) return;
  // Public mentions are ingestible. DMs fall out in the filter. Do not await.
  fireHonchoIngest(event, honchoExtras(client, logger));
  const channel = event.channel;
  await addAckReaction(client, channel, event.ts, logger);
  const enriched = await enrichChannelType(client, event, logger);
  const threadTs = threadTsFor(enriched);
  const fields = replyFields(enriched);
  try {
    const slack = await summarizeEvent(client, enriched);
    const payload = {
      source: BRIDGE_SOURCE,
      kind,
      slack,
      hold_ack: looksPersonal(slack.text) ? "personal" : "generic",
      reply: fields,
    };
    try {
      const assistant = await assistantForWake(process.env, enriched);
      if (assistant) payload.assistant = assistant;
    } catch (err) {
      logger?.warn?.("assistant context", err?.message || err);
    }
    await wakeGrok(payload);
    logger.info(`[${ts()}] wake ok`, kind, channel, event.ts);
    await clearThinking(client, channel, threadTs, logger);
    await postHoldAck(client, channel, slack.text, fields, logger);
  } catch (err) {
    logger.error(`[${ts()}] wake FAILED`, kind, channel, event.ts, err?.message || err);
    await clearThinking(client, channel, threadTs, logger);
    if (sayOnFail) {
      try {
        const payload = { text: "Could not reach Grok webhook. Check GROK_WEBHOOK_URL / secret." };
        if (fields.thread_ts) payload.thread_ts = fields.thread_ts;
        if (fields.reply_broadcast) payload.reply_broadcast = true;
        await sayOnFail(payload);
      } catch (sayErr) {
        logger.error(sayErr);
      }
    }
  }
}

function silentRecordOn() {
  const v = String(process.env.SILENT_RECORD || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function fireSilentRecord(event, client, logger) {
  if (!silentRecordOn()) return;
  void import("./cloudflare-relay/src/honcho.js")
    .then((m) => m.ingestSilentIfEnabled(process.env, event, {
      log: (...args) => (logger?.info ? logger.info(...args) : console.log(...args)),
      resolveDisplay: async (userId) => {
        const info = await resolveUser(client, userId);
        return info?.display_name || info?.real_name || info?.name || null;
      },
    }))
    .catch((err) => {
      const msg = err?.message || err;
      if (logger?.error) logger.error(`[${ts()}] honcho record failed`, msg);
      else console.error(`[${ts()}] honcho record failed`, msg);
    });
}

async function maybeAnswerRecordSearch(event, client, logger) {
  if (event?.channel_type !== "im" || !String(event?.channel || "").startsWith("D")) return false;
  if (!/\b(search|history|transcript|recall|recorded|recording|what was said|what did)\b/i.test(String(event?.text || ""))) return false;
  const m = await import("./cloudflare-relay/src/honcho.js");
  const decision = m.classifyRecordSearch(process.env, event);
  if (decision.kind !== "allow") return false;
  try {
    const result = await m.queryRecordSession(process.env, { source: "slack-im", event });
    const text = m.formatRecordReply(result, { label: decision.channelId });
    await client.chat.postMessage({ channel: event.channel, text });
    logger?.info?.(`[${ts()}] record search posted`, decision.channelId, decision.requesterId);
  } catch (err) {
    logger?.error?.(`[${ts()}] record search failed`, err?.message || err);
  }
  return true;
}

app.event("app_mention", async ({ event, say, client, logger }) => {
  // Before thinking, reaction, hold-ack, and wake. Edited mentions included.
  if (isSilentEvent(event)) {
    logger.info(`[${ts()}] silent channel; no ack, no wake`, eventChannelId(event), event?.ts);
    fireSilentRecord(event, client, logger);
    return;
  }
  if (await maybeAnswerRecordSearch(event, client, logger)) return;
  if (!isAllowedBotMention(event)) {
    logger.info("app_mention ignored (bot not allowlisted)", event.bot_id, event.user);
    return;
  }

  if (!firstWake(event.channel, event.ts)) return;
  logger.info(`[${ts()}] app_mention`, event.channel, event.user);
  const threadTs = threadTsFor(event);

  await setThinking(client, event.channel, threadTs, logger);

  void processInbound({
    kind: "app_mention",
    event,
    client,
    logger,
    sayOnFail: say,
  });
});

app.message(async ({ message, client, logger }) => {
  // Before ingest, thinking, reaction, and wake. Edits carry the channel on the
  // outer event or on message.message. Recording is not enabled here.
  if (isSilentEvent(message)) {
    logger.info(`[${ts()}] silent channel; no ack, no wake`, eventChannelId(message), message?.ts || message?.message?.ts);
    fireSilentRecord(message, client, logger);
    return;
  }
  if (await maybeAnswerRecordSearch(message, client, logger)) return;
  // Silent public-channel ingest. Does not set thinking or wake Grok.
  // Slack only delivers these when message.channels is subscribed. DMs are filtered out.
  fireHonchoIngest(message, honchoExtras(client, logger));
  if (!isUserPost(message)) return;
  if (message.channel_type !== "im" && message.channel_type !== "mpim") return;
  if (!firstWake(message.channel, message.ts)) return;

  logger.info(`[${ts()}] ${message.channel_type}`, message.channel, message.user, message.subtype || "", message.files ? `files=${message.files.length}` : "");
  const threadTs = threadTsFor(message);

  await setThinking(client, message.channel, threadTs, logger);

  void processInbound({
    kind: "message",
    event: message,
    client,
    logger,
    sayOnFail: null,
  });
});

// In-process store so Socket Mode can keep assistant-thread context without KV.
// The Worker uses PRIVROOM_STATE instead. Shape matches that binding's get/put.
const assistantMemory = new Map();
const assistantKv = {
  async get(key) { return assistantMemory.has(key) ? assistantMemory.get(key) : null; },
  async put(key, value) { assistantMemory.set(key, value); },
};
let assistantApi = null;
function assistantEnv() {
  return { ...process.env, PRIVROOM_STATE: assistantKv };
}
async function loadAssistantApi() {
  if (!assistantApi) assistantApi = await import("./cloudflare-relay/src/index.js");
  return assistantApi;
}
async function assistantForWake(env, event) {
  const api = await loadAssistantApi();
  return api.assistantForWake({ ...env, PRIVROOM_STATE: assistantKv }, event);
}
async function onAssistantControl(event, logger) {
  try {
    const api = await loadAssistantApi();
    await api.handleAssistantEvent(assistantEnv(), event, null);
  } catch (err) {
    logger?.warn?.("assistant event failed", event?.type, err?.message || err);
  }
}
app.event("assistant_thread_started", async ({ event, logger }) => onAssistantControl(event, logger));
app.event("assistant_thread_context_changed", async ({ event, logger }) => onAssistantControl(event, logger));
app.event("app_context_changed", async ({ event, logger }) => onAssistantControl(event, logger));
app.event("app_home_opened", async ({ event, logger }) => onAssistantControl(event, logger));

// Fail fast on startup/unexpected errors so the supervisor restarts cleanly.
process.on("unhandledRejection", (err) => {
  console.error(`[${ts()}] unhandledRejection - exiting`, err?.data?.error || err?.message || err);
  process.exit(1);
});
const startTimer = setTimeout(() => {
  console.error(`[${ts()}] app.start() did not complete within ${STARTUP_TIMEOUT_MS / 1000}s - exiting`);
  process.exit(1);
}, STARTUP_TIMEOUT_MS);

(async () => {
  await app.start();
  clearTimeout(startTimer);
  try {
    const auth = await app.client.auth.test();
    ownBotId = auth.bot_id || null;
    ownUserId = auth.user_id || null;
  } catch (err) {
    console.warn("auth.test failed; self-loop guard may be incomplete", err?.data?.error || err?.message || err);
  }
  console.log(
    `[${ts()}] ⚡️ ${BRIDGE_SOURCE} running (Socket Mode; ping ${CLIENT_PING_TIMEOUT_MS}/${SERVER_PING_TIMEOUT_MS}ms; watchdog ${WATCHDOG_MAX_UNHEALTHY_MS}ms; ack-first + thinking + reaction${HOLD_ACK ? " + hold-ack" : ""}; allow bots: ${[...ALLOW_BOT_IDS, ...ALLOW_BOT_USER_IDS].join(",") || "none"})`
  );
})();
