/**
 * Slack Socket Mode → Grok inbound webhook bridge (template).
 * Listens for app mentions / DMs and POSTs a short payload to a Grok inbound webhook.
 *
 * Required env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, GROK_WEBHOOK_URL
 * Optional: SLACK_SIGNING_SECRET, GROK_WEBHOOK_SECRET, BRIDGE_SOURCE,
 *           THINKING_TIMEOUT_MS (default 45000), HOLD_ACK (default "true"),
 *           HOLD_ACK_BROADCAST (default "true"), OWNER_DISPLAY_NAME (default "the owner"),
 *           ALLOW_BOT_IDS / ALLOW_BOT_USER_IDS (comma-separated; empty = ignore bot mentions)
 *
 * Ack model: Bolt acks a Socket Mode event when this listener's Promise settles.
 * Never await the Grok webhook (or other slow work) before returning - fire it
 * after a fast thinking status so Slack does not retry (3s) and duplicate wakes.
 *
 * After a successful webhook wake, post an instant threaded hold-ack so the room
 * knows the bot heard them while the human owner reviews. Personal/family asks
 * get a stronger privacy hold message.
 */
const { App } = require("@slack/bolt");

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

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET || "unused-for-socket-mode",
  socketMode: true,
});

const userCache = new Map();
const thinkingTimers = new Map();

const LOADING_MESSAGES = [
  "checking with the owner…",
  "asking Grok…",
  "almost there…",
];

// Heuristic only: stronger hold when the ask looks personal / family / schedule.
const PERSONAL_RE =
  /\b(REDACTED|REDACTED|REDACTED|\bmax\b|REDACTED|kids?|child|daughter|son|family|school|calendar|schedule|class(?:es)?|piano|sewing|gymnastics|art class|pickup|carpool|address|home|phone|email|where (?:is|are)|what time|taking)\b/i;

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
  };
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
    await clearThinking(client, channel, threadTs, logger);
    await postHoldAck(client, channel, threadTs, slack.text, logger);
  } catch (err) {
    logger.error(err);
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

  logger.info("app_mention", event.channel, event.user);
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
  if (message.subtype || message.bot_id) return;
  if (message.channel_type !== "im" && message.channel_type !== "mpim") return;

  logger.info("dm/mpim", message.channel, message.user);
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

(async () => {
  await app.start();
  try {
    const auth = await app.client.auth.test();
    ownBotId = auth.bot_id || null;
    ownUserId = auth.user_id || null;
  } catch (err) {
    console.warn("auth.test failed; self-loop guard may be incomplete", err?.data?.error || err?.message || err);
  }
  console.log(
    `⚡️ ${BRIDGE_SOURCE} running (Socket Mode; ack-first + thinking + hold-ack; allow bots: ${[...ALLOW_BOT_IDS, ...ALLOW_BOT_USER_IDS].join(",") || "none"})`
  );
})();
