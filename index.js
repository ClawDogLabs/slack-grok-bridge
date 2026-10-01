/**
 * Slack Socket Mode → Grok inbound webhook bridge (template).
 * Listens for app mentions / DMs / messages and POSTs a short payload to a Grok inbound webhook.
 *
 * Required env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, GROK_WEBHOOK_URL
 *
 * Ack model: Bolt acks a Socket Mode event when this listener's Promise settles.
 * Never await the Grok webhook (or other slow work) before returning - fire it
 * after a fast thinking status so Slack does not retry (3s) and duplicate wakes.
 */
const { App } = require("@slack/bolt");

const required = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "GROK_WEBHOOK_URL"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing ${key}. Copy .env.example to .env and fill tokens (or set env vars).`);
    process.exit(1);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET || "unused-for-socket-mode",
  socketMode: true,
});

const userCache = new Map();

const LOADING_MESSAGES = [
  "checking the schedule…",
  "asking Grok…",
  "almost there…",
];

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

async function setThinking(client, channel, threadTs, logger) {
  if (!channel || !threadTs) return;
  try {
    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: threadTs,
      status: "is thinking…",
      loading_messages: LOADING_MESSAGES,
    });
  } catch (err) {
    logger?.warn?.("assistant.threads.setStatus failed", err?.data?.error || err?.message || err);
  }
}

async function clearThinking(client, channel, threadTs, logger) {
  if (!channel || !threadTs) return;
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

/**
 * Slow path: resolve user, wake Grok. Runs AFTER the Bolt listener returns (ack).
 * Status clears automatically when a later chat.postMessage lands in-thread;
 * we only clear explicitly on webhook failure.
 */
async function processInbound({ kind, event, client, logger, sayOnFail }) {
  const channel = event.channel;
  const threadTs = threadTsFor(event);
  try {
    const slack = await summarizeEvent(client, event);
    await wakeGrok({
      source: "slack-grok-bridge",
      kind,
      slack,
    });
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
  // Loop guard: ignore our own / other bot chatter if it ever arrives here
  if (event.bot_id || event.subtype === "bot_message") return;

  logger.info("app_mention", event.channel, event.user);
  const threadTs = threadTsFor(event);

  // Fast path before ack settles: show spinner, then return.
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
  // Skip bot messages and subtypes we do not care about (loop prevention)
  if (message.subtype || message.bot_id) return;
  // In channels, prefer app_mention; still forward DMs
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
  console.log("⚡️ slack-grok-bridge running (Socket Mode; ack-first + thinking status)");
})();
