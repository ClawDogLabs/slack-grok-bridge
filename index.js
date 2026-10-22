/**
 * Slack Socket Mode → Grok inbound webhook bridge (template).
 * Listens for app mentions / DMs and POSTs a short payload to a Grok inbound webhook.
 *
 * Required env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, GROK_WEBHOOK_URL
 * Optional: SLACK_SIGNING_SECRET, GROK_WEBHOOK_SECRET, BRIDGE_SOURCE,
 *           THINKING_TIMEOUT_MS (default 45000), HOLD_ACK (default "true"),
 *           HOLD_ACK_BROADCAST (default "true"), OWNER_DISPLAY_NAME (default "the owner"),
 *           ALLOW_BOT_IDS / ALLOW_BOT_USER_IDS (comma-separated; empty = ignore bot mentions),
 *           CLIENT_PING_TIMEOUT_MS (default 15000), SERVER_PING_TIMEOUT_MS (default 60000),
 *           WATCHDOG_MAX_UNHEALTHY_MS (default 120000)
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
 * After a successful webhook wake, post an instant threaded hold-ack so the room
 * knows the bot heard them while the human owner reviews. Personal/family asks
 * get a stronger privacy hold message.
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
const HOLD_ACK = String(process.env.HOLD_ACK || "true").toLowerCase() !== "false";
const OWNER_DISPLAY_NAME = process.env.OWNER_DISPLAY_NAME || "the owner";
const HOLD_ACK_BROADCAST = String(process.env.HOLD_ACK_BROADCAST || "true").toLowerCase() !== "false";
const THINKING_TIMEOUT_MS = Number(process.env.THINKING_TIMEOUT_MS || 45000);

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
  "schedule", "class(?:es)?", "piano", "sewing", "gymnastics", "art class",
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

async function postHoldAck(client, channel, threadTs, text, logger) {
  if (!HOLD_ACK || !channel || !threadTs) return;
  const body = looksPersonal(text) ? HOLD_ACK_PERSONAL : HOLD_ACK_GENERIC;
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: body,
      reply_broadcast: HOLD_ACK_BROADCAST,
    });
  } catch (err) {
    logger?.warn?.("hold-ack post failed", err?.data?.error || err?.message || err);
  }
}

/**
 * Slow path: resolve user, wake Grok. Runs AFTER the Bolt listener returns (ack).
 * Clear thinking as soon as the webhook is accepted, then post an instant hold-ack
 * so the room is not left on a forever spinner while the owner reviews.
 */
async function processInbound({ kind, event, client, logger, sayOnFail }) {
  const channel = event.channel;
  const threadTs = threadTsFor(event);
  try {
    const slack = await summarizeEvent(client, event);
    await wakeGrok({
      source: BRIDGE_SOURCE,
      kind,
      slack,
      hold_ack: looksPersonal(slack.text) ? "personal" : "generic",
    });
    logger.info(`[${ts()}] wake ok`, kind, channel, event.ts);
    await clearThinking(client, channel, threadTs, logger);
    await postHoldAck(client, channel, threadTs, slack.text, logger);
  } catch (err) {
    logger.error(`[${ts()}] wake FAILED`, kind, channel, event.ts, err?.message || err);
    await clearThinking(client, channel, threadTs, logger);
    if (sayOnFail) {
      try {
        await sayOnFail({
          text: "Could not reach Grok webhook. Check GROK_WEBHOOK_URL / secret.",
          thread_ts: threadTs,
        });
      } catch (sayErr) {
        logger.error(sayErr);
      }
    }
  }
}

app.event("app_mention", async ({ event, say, client, logger }) => {
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
    `[${ts()}] ⚡️ ${BRIDGE_SOURCE} running (Socket Mode; ping ${CLIENT_PING_TIMEOUT_MS}/${SERVER_PING_TIMEOUT_MS}ms; watchdog ${WATCHDOG_MAX_UNHEALTHY_MS}ms; ack-first + thinking + hold-ack; allow bots: ${[...ALLOW_BOT_IDS, ...ALLOW_BOT_USER_IDS].join(",") || "none"})`
  );
})();
