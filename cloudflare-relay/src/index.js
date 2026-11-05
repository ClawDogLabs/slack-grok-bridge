/**
 * slack-bridge-example — always-on Cloudflare Worker that receives Slack Events API HTTP requests
 * and forwards them to a Grok Bot inbound (routine) webhook.
 *
 * It replaces the *receiving* half of the Socket Mode bridge (../index.js) for hosts that sleep
 * or freeze when idle: Slack delivers to this Worker over HTTPS, the Worker wakes Grok, and the
 * Grok routine replies with the bot token. Same routing rules, same webhook payload and headers
 * as the bridge, so an existing wake routine needs no change.
 *
 * Secrets (wrangler secret put): SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GROK_WEBHOOK_URL,
 *                                GROK_WEBHOOK_SECRET (optional but recommended),
 *                                HONCHO_API_KEY (only used when HONCHO_INGEST is on)
 * Vars (wrangler.toml [vars]):   see wrangler.toml.example
 *
 * HONCHO_INGEST defaults off. Public-channel memory writes run in ctx.waitUntil
 * and are never awaited on the wakeGrok path. See src/honcho.js.
 *
 * Acknowledgement is a reaction (ACK_REACTION, default white_check_mark). The text
 * hold-ack is opt-in (HOLD_ACK=true). Replies the Worker itself posts follow the
 * threading rule: plain in DMs/group DMs unless already threaded; thread +
 * reply_broadcast in channels. The same placement is sent as `reply` on the webhook.
 *
 * Every request is answered fast (200 within ms); slow work runs in ctx.waitUntil so Slack's
 * 3-second deadline is never at risk.
 */

import { ingestIfEnabled } from "./honcho.js";

const enc = new TextEncoder();
const FORWARD_SUBTYPES = new Set(["file_share"]);
const PERSONAL_BASE_TERMS = [
  "kids?", "child", "daughter", "son", "family", "school", "calendar",
  "schedule", "class(?:es)?", "lessons?", "practice", "activit(?:y|ies)", "sports?",
  "pickup", "carpool", "address", "home", "phone", "email",
  "where (?:is|are)", "what time", "taking",
];

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const idSet = (v) => new Set(list(v));
const isTrue = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : String(v).toLowerCase() !== "false");
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Slack emoji name (no colons). Empty uses the default. "off" / "false" / "none" disables the reaction. */
export const DEFAULT_ACK_EMOJI = "white_check_mark";
export function ackEmoji(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_ACK_EMOJI;
  const name = String(value).trim().replace(/^:+|:+$/g, "");
  if (!name || /^(off|false|none|0)$/i.test(name)) return null;
  return name;
}

/**
 * Where a reply to this event belongs.
 * DMs and group DMs stay top-level unless the message is already in a thread.
 * Channels (and private channels) reply in a thread and also broadcast to the channel.
 * A channel id starting with D is a DM even when channel_type was not on the event.
 * `thread_ts` is null when the reply should be top-level.
 */
export function replyFields(event) {
  const channel = String(event?.channel || "");
  const ct = event?.channel_type;
  const isDm = ct === "im" || ct === "mpim" || channel.startsWith("D");
  const parent = event?.thread_ts && event.thread_ts !== event?.ts ? event.thread_ts : null;
  if (isDm) return { thread_ts: parent, reply_broadcast: false };
  return { thread_ts: parent || event?.ts || null, reply_broadcast: true };
}

/** chat.postMessage args. Omits thread_ts / reply_broadcast when the placement doesn't use them. */
export function postMessageArgs(channel, text, fields) {
  const body = { channel, text };
  if (fields?.thread_ts) body.thread_ts = fields.thread_ts;
  if (fields?.reply_broadcast) body.reply_broadcast = true;
  return body;
}

// Own ids: from vars if set, else looked up once per isolate with auth.test.
let selfCache = null;

export function cfg(env) {
  const owner = env.OWNER_DISPLAY_NAME || "the owner";
  const botName = String(env.BOT_NAME || "").trim();
  let holdAckSkip = null;
  if (env.HOLD_ACK_SKIP_REGEX) {
    try { holdAckSkip = new RegExp(env.HOLD_ACK_SKIP_REGEX, "i"); } catch { log("bad HOLD_ACK_SKIP_REGEX; ignored"); }
  }
  return {
    source: env.BRIDGE_SOURCE || "slack-grok-bridge",
    owner,
    // Text hold-ack is opt-in. The default acknowledgement is a reaction (see ackReaction).
    holdAck: isTrue(env.HOLD_ACK, false),
    holdAckBroadcast: isTrue(env.HOLD_ACK_BROADCAST, true),
    ackReaction: ackEmoji(env.ACK_REACTION),
    holdAckSkip,
    holdAckGeneric: `Got it - checking with ${owner} and will get back to you.`,
    holdAckPersonal: `That's not on my approved list of things to share publicly. Let me check with ${owner} and get back to you.`,
    loading: [`checking with ${owner}…`, "asking Grok…", "almost there…"],
    personalRe: new RegExp(`\\b(${[...list(env.PERSONAL_NAMES).map(escapeRegex), ...PERSONAL_BASE_TERMS].join("|")})\\b`, "i"),
    botNameRe: botName ? new RegExp(`\\b${escapeRegex(botName)}\\b`, "i") : null,
    ownUserId: env.OWN_USER_ID || selfCache?.userId || null,
    ownBotId: env.OWN_BOT_ID || selfCache?.botId || null,
    mpimRequireAddress: isTrue(env.MPIM_REQUIRE_ADDRESS, false),
    watch: idSet(env.WATCH_CHANNEL_IDS),
    welcome: idSet(env.WELCOME_CHANNEL_IDS),
    welcomeText: env.WELCOME_TEXT || ":wave: Welcome, {user}! Ask me anything {ask_channel}, or @mention me in any channel I'm in.",
    askChannel: env.ASK_CHANNEL_ID || null,
    allowBotIds: idSet(env.ALLOW_BOT_IDS),
    allowBotUserIds: idSet(env.ALLOW_BOT_USER_IDS),
    retryPolicy: (env.RETRY_POLICY || "drop_timeouts").toLowerCase(),
  };
}

// ---------------------------------------------------------------- signature check
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function slackSignature(secret, ts, rawBody) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${rawBody}`));
  return "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function verifySlack(request, rawBody, secret) {
  const ts = request.headers.get("X-Slack-Request-Timestamp");
  const sig = request.headers.get("X-Slack-Signature");
  if (!ts || !sig || !/^\d+$/.test(ts)) return "missing signature";
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return "stale timestamp";
  return timingSafeEqual(await slackSignature(secret, ts, rawBody), sig) ? null : "bad signature";
}

// ---------------------------------------------------------------- routing (pure, sync)
function isAllowedBotMention(e, c) {
  if (!e.bot_id && e.subtype !== "bot_message") return true; // human
  if (c.ownBotId && e.bot_id === c.ownBotId) return false;
  if (c.ownUserId && e.user === c.ownUserId) return false;
  if (e.bot_id && c.allowBotIds.has(e.bot_id)) return true;
  if (e.user && c.allowBotUserIds.has(e.user)) return true;
  return false;
}
function isUserPost(m, c) {
  if (m.bot_id) return false;
  if (c.ownUserId && m.user === c.ownUserId) return false;
  return !m.subtype || FORWARD_SUBTYPES.has(m.subtype);
}
function addressesBot(text, c) {
  const t = String(text || "");
  if (c.ownUserId && t.includes(`<@${c.ownUserId}>`)) return true;
  return !!c.botNameRe && c.botNameRe.test(t);
}
/** Cheap pre-filter for watched channels so side-chatter never wakes Grok. Grok still decides. */
function worthForwarding(text, c) {
  const t = String(text || "").trim();
  if (!t) return false;
  if ((c.botNameRe && c.botNameRe.test(t)) || t.includes("?")) return true;
  return t.split(/\s+/).filter(Boolean).length > 4;
}

/** Returns { action, reason }. action: wake_mention | wake_dm | watched | welcome | ignore */
export function route(e, c) {
  if (!e || typeof e !== "object") return { action: "ignore", reason: "no-event" };
  const mentionsMe = !!c.ownUserId && String(e.text || "").includes(`<@${c.ownUserId}>`);

  if (e.type === "app_mention") {
    if (!isAllowedBotMention(e, c)) return { action: "ignore", reason: "bot-not-allowlisted" };
    // 1:1 DMs are handled by the message.im path (the bridge dedupes these by channel:ts).
    if (String(e.channel || "").startsWith("D")) return { action: "ignore", reason: "dm-handled-by-message" };
    return { action: "wake_mention", reason: "app_mention" };
  }
  if (e.type !== "message") return { action: "ignore", reason: `type:${e.type}` };

  if (e.subtype === "channel_join" || e.subtype === "group_join") {
    if (!c.welcome.has(e.channel)) return { action: "ignore", reason: "join-not-welcome-channel" };
    if (!e.user || (c.ownUserId && e.user === c.ownUserId)) return { action: "ignore", reason: "join-self" };
    return { action: "welcome", reason: "join" };
  }
  if (!isUserPost(e, c)) return { action: "ignore", reason: e.bot_id ? "bot" : `subtype:${e.subtype}` };

  const ct = e.channel_type;
  if (ct === "channel" || ct === "group") {
    if (mentionsMe) return { action: "ignore", reason: "mention-handled-by-app_mention" };
    if (!c.watch.has(e.channel)) return { action: "ignore", reason: "not-watched" };
    if (!worthForwarding(e.text, c)) return { action: "ignore", reason: "chatter" };
    return { action: "watched", reason: "watched-channel" };
  }
  if (ct !== "im" && ct !== "mpim") return { action: "ignore", reason: `channel_type:${ct}` };
  if (ct === "mpim") {
    // An explicit @mention in a group DM also arrives as app_mention; let that one wake.
    if (mentionsMe) return { action: "ignore", reason: "mention-handled-by-app_mention" };
    if (c.mpimRequireAddress && !addressesBot(e.text, c)) return { action: "ignore", reason: "mpim-not-addressed" };
  }
  return { action: "wake_dm", reason: ct };
}

/** Slack retries (X-Slack-Retry-Num). Returns true if this retry should be dropped. */
export function dropRetry(reason, c) {
  if (c.retryPolicy === "process_all") return false;
  if (c.retryPolicy === "drop_all") return true;
  // drop_timeouts (default): the first attempt reached us and its work is already running in
  // waitUntil, so a timeout retry would double-wake. Other reasons (http_error,
  // connection_failed, ...) mean the first attempt was NOT handled - process those, which is
  // what makes Slack's Delayed Events a real safety net.
  return String(reason || "") === "http_timeout";
}

// ---------------------------------------------------------------- Slack Web API
async function slackApi(env, method, body, { get = false, quiet = false } = {}) {
  const url = `https://slack.com/api/${method}`;
  const headers = { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` };
  let res;
  if (get) {
    res = await fetch(`${url}?${new URLSearchParams(body)}`, { headers });
  } else {
    headers["Content-Type"] = "application/json; charset=utf-8";
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  }
  const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
  if (!data.ok && !quiet) log(`slack ${method} failed:`, data.error);
  return data;
}

const channelKindCache = new Map();
let loggedChannelScope = false;

/**
 * Wake-path classifier. Still fail-open ("channel") when conversations.info
 * cannot tell. Honcho ingest must not use this result: see lookupIngestChannel.
 */
async function resolveChannelType(env, e) {
  const ct = e?.channel_type;
  if (ct === "im" || ct === "mpim" || ct === "channel" || ct === "group") return ct;
  const channel = String(e?.channel || "");
  if (channel.startsWith("D")) return "im";
  if (!channel || !env.SLACK_BOT_TOKEN) return "channel";
  if (channelKindCache.has(channel)) return channelKindCache.get(channel);
  const info = await slackApi(env, "conversations.info", { channel }, { get: true, quiet: true }).catch(() => null);
  if (!info?.ok || !info.channel) {
    if (info?.error === "missing_scope" && !loggedChannelScope) {
      loggedChannelScope = true;
      log("conversations.info missing scope; @mentions without channel_type are treated as channels. Add channels:read, groups:read, im:read, or mpim:read to classify group DMs.");
    }
    return "channel";
  }
  const ch = info.channel;
  const kind = ch.is_im ? "im" : ch.is_mpim ? "mpim" : (ch.is_group || ch.is_private) ? "group" : "channel";
  channelKindCache.set(channel, kind);
  return kind;
}

/** React to the message that just arrived. Custom emoji missing → white_check_mark. Missing scope is logged once per call. */
async function addAckReaction(env, c, channel, ts) {
  if (!c.ackReaction || !channel || !ts) return;
  const name = c.ackReaction;
  const res = await slackApi(env, "reactions.add", { channel, timestamp: ts, name }, { quiet: true }).catch((err) => ({ ok: false, error: err?.message || "request_failed" }));
  if (res?.ok || res?.error === "already_reacted") return;
  if (res?.error === "missing_scope") {
    log("ack reaction skipped: bot token is missing reactions:write (add the scope and reinstall the app)");
    return;
  }
  if ((res?.error === "invalid_name" || res?.error === "emoji_not_found") && name !== DEFAULT_ACK_EMOJI) {
    log(`ack reaction :${name}: is not available; falling back to :${DEFAULT_ACK_EMOJI}:`);
    const fallback = await slackApi(env, "reactions.add", { channel, timestamp: ts, name: DEFAULT_ACK_EMOJI }, { quiet: true }).catch((err) => ({ ok: false, error: err?.message || "request_failed" }));
    if (fallback?.error === "missing_scope") {
      log("ack reaction skipped: bot token is missing reactions:write (add the scope and reinstall the app)");
    } else if (!fallback?.ok && fallback?.error !== "already_reacted") {
      log("ack reaction fallback failed:", fallback?.error || "unknown");
    }
    return;
  }
  if (res?.error) log("ack reaction failed:", res.error);
}

async function ensureSelf(env) {
  if ((env.OWN_USER_ID && env.OWN_BOT_ID) || selfCache || !env.SLACK_BOT_TOKEN) return;
  const r = await slackApi(env, "auth.test", {}).catch(() => null);
  if (r?.ok) selfCache = { userId: r.user_id || null, botId: r.bot_id || null };
}

async function resolveUser(env, userId) {
  if (!userId) return null;
  const res = await slackApi(env, "users.info", { user: userId }, { get: true }).catch(() => null);
  if (!res?.ok || !res.user) return { id: userId };
  const p = res.user.profile || {};
  return {
    id: userId,
    name: res.user.name || null,
    real_name: res.user.real_name || p.real_name || null,
    display_name: p.display_name || null,
    is_bot: !!res.user.is_bot,
  };
}

async function summarizeEvent(env, e) {
  const u = await resolveUser(env, e.user);
  return {
    type: e.type,
    user: e.user,
    user_name: u?.name || null,
    user_real_name: u?.real_name || null,
    user_display_name: u?.display_name || null,
    channel: e.channel,
    channel_type: e.channel_type,
    ts: e.ts,
    thread_ts: e.thread_ts,
    text: e.text,
    subtype: e.subtype || null,
    files: Array.isArray(e.files)
      ? e.files.map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype, filetype: f.filetype, url_private: f.url_private }))
      : undefined,
  };
}

async function wakeGrok(env, payload) {
  const headers = { "Content-Type": "application/json" };
  if (env.GROK_WEBHOOK_SECRET) {
    headers["Authorization"] = `Bearer ${env.GROK_WEBHOOK_SECRET}`;
    headers["X-Automation-Key"] = env.GROK_WEBHOOK_SECRET;
  }
  const res = await fetch(env.GROK_WEBHOOK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Grok webhook ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

const setThinking = (env, c, channel, threadTs) =>
  slackApi(env, "assistant.threads.setStatus", {
    channel_id: channel, thread_ts: threadTs, status: "is thinking…", loading_messages: c.loading,
  }).catch(() => {});
const clearThinking = (env, channel, threadTs) =>
  slackApi(env, "assistant.threads.setStatus", { channel_id: channel, thread_ts: threadTs, status: "" }).catch(() => {});

async function postHoldAck(env, c, channel, fields, text) {
  if (!c.holdAck || !channel) return;
  if (c.holdAckSkip && c.holdAckSkip.test(String(text || ""))) return log("hold-ack skipped (HOLD_ACK_SKIP_REGEX)");
  const body = c.personalRe.test(String(text || "")) ? c.holdAckPersonal : c.holdAckGeneric;
  const placement = fields?.reply_broadcast ? { ...fields, reply_broadcast: c.holdAckBroadcast } : fields;
  await slackApi(env, "chat.postMessage", postMessageArgs(channel, body, placement)).catch(() => {});
}

// ---------------------------------------------------------------- handlers (run in waitUntil)
async function processInbound(env, c, kind, e, sayOnFail) {
  const channel = e.channel;
  const threadTs = e.thread_ts || e.ts;
  const placement = replyFields(e);
  await addAckReaction(env, c, channel, e.ts);
  await setThinking(env, c, channel, threadTs);
  try {
    const slack = await summarizeEvent(env, e);
    await wakeGrok(env, {
      source: c.source,
      kind,
      slack,
      hold_ack: c.personalRe.test(String(slack.text || "")) ? "personal" : "generic",
      reply: placement,
    });
    log("wake ok", kind, channel, e.ts);
    await clearThinking(env, channel, threadTs);
    await postHoldAck(env, c, channel, placement, slack.text);
  } catch (err) {
    log("wake FAILED", kind, channel, e.ts, err?.message || err);
    await clearThinking(env, channel, threadTs);
    if (sayOnFail) {
      await slackApi(env, "chat.postMessage", postMessageArgs(
        channel,
        "Could not reach Grok webhook. Check GROK_WEBHOOK_URL / secret.",
        placement,
      )).catch(() => {});
    }
  }
}

async function forwardWatched(env, c, e) {
  try {
    const slack = await summarizeEvent(env, e);
    await wakeGrok(env, { source: c.source, kind: "channel_message", watched: true, slack, reply: replyFields(e) });
    log("wake ok", "channel_message", e.channel, e.ts);
  } catch (err) {
    log("wake FAILED", "channel_message", e.channel, e.ts, err?.message || err);
  }
}

async function welcome(env, c, e) {
  const info = await resolveUser(env, e.user);
  if (info?.is_bot) return;
  if (e.ts) await slackApi(env, "reactions.add", { channel: e.channel, timestamp: e.ts, name: "wave" }).catch(() => {});
  const where = c.askChannel ? `in <#${c.askChannel}>` : "here";
  const text = c.welcomeText.replaceAll("{user}", `<@${e.user}>`).replaceAll("{ask_channel}", where);
  await slackApi(env, "chat.postMessage", { channel: e.channel, text }).catch(() => {});
  log("welcomed", e.channel, e.user);
}

let loggedHonchoScope = false;

// Ingest-only lookup. null means unresolved (missing_scope, no token, error).
// Does not fail open to "channel". Cached by ingestIfEnabled.
async function lookupIngestChannel(env, channel) {
  if (!channel || !env.SLACK_BOT_TOKEN) return null;
  const info = await slackApi(env, "conversations.info", { channel }, { get: true, quiet: true }).catch(() => null);
  if (!info?.ok || !info.channel) {
    if (info?.error === "missing_scope" && !loggedHonchoScope) {
      loggedHonchoScope = true;
      log("honcho conversations.info missing_scope; set HONCHO_CHANNEL_IDS until channels:read is granted");
    }
    return null;
  }
  return info.channel;
}

// Separate from wake. Runs for public messages route() ignores (the usual case
// outside WATCH_CHANNEL_IDS) and for our own bot replies in public channels.
// Returns null when HONCHO_INGEST is off. Caller must only waitUntil the promise.
// Missing channel_type: HONCHO_CHANNEL_IDS, else conversations.info, else skip.
function scheduleHoncho(env, c, e) {
  return ingestIfEnabled(env, e, {
    ownUserId: c.ownUserId,
    ownBotId: c.ownBotId,
    personalRe: c.personalRe,
    log: (...a) => log(...a),
    lookupChannel: (channel) => lookupIngestChannel(env, channel),
    resolveDisplay: async (userId) => {
      const u = await resolveUser(env, userId);
      return u?.display_name || u?.real_name || u?.name || null;
    },
  });
}

async function handle(env, c, e, action) {
  if (action === "welcome") return welcome(env, c, e);
  const event = { ...e, channel_type: await resolveChannelType(env, e) };
  if (action === "wake_mention") return processInbound(env, c, "app_mention", event, true);
  if (action === "wake_dm") return processInbound(env, c, "message", event, false);
  if (action === "watched") return forwardWatched(env, c, event);
}

// ---------------------------------------------------------------- entry
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extra } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "slack-bridge-example", configured: !!(env.SLACK_SIGNING_SECRET && env.GROK_WEBHOOK_URL && env.SLACK_BOT_TOKEN) });
    }
    if (request.method !== "POST" || !(url.pathname === "/" || url.pathname === "/slack/events")) {
      return new Response("not found", { status: 404 });
    }
    // Fail closed: without a signing secret nothing is trusted.
    if (!env.SLACK_SIGNING_SECRET) return json({ ok: false, error: "signing secret not configured" }, 503);

    const raw = await request.text();
    const bad = await verifySlack(request, raw, env.SLACK_SIGNING_SECRET);
    if (bad) return json({ ok: false, error: bad }, 401);

    let body;
    try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "bad json" }, 400); }

    // Slack's one-time Request URL handshake (the reason a plain routine webhook can't be used).
    if (body.type === "url_verification") return json({ challenge: body.challenge });
    if (body.type !== "event_callback") return json({ ok: true, action: "ignore", reason: `type:${body.type}` });

    await ensureSelf(env);
    const c = cfg(env);

    const retryNum = request.headers.get("X-Slack-Retry-Num");
    const retryReason = request.headers.get("X-Slack-Retry-Reason");
    if (retryNum && dropRetry(retryReason, c)) {
      log("retry dropped", retryNum, retryReason, body.event_id);
      return json({ ok: true, action: "ignore", reason: "retry" }, 200, { "X-Relay-Action": "ignore:retry" });
    }

    const e = body.event;
    const { action, reason } = route(e, c);
    log("event", body.event_id, e?.type, e?.subtype || "", e?.channel, "->", action, reason, retryNum ? `retry=${retryNum}:${retryReason}` : "");
    // Honcho is not on the wake path. Slack is acked below whether or not this runs.
    // message.channels must be subscribed or ordinary public messages never arrive.
    const honchoTask = scheduleHoncho(env, c, e);
    if (action !== "ignore") ctx.waitUntil(handle(env, c, e, action).catch((err) => log("handler error", err?.message || err)));
    if (honchoTask) ctx.waitUntil(honchoTask);
    return json({ ok: true }, 200, { "X-Relay-Action": `${action}:${reason}` });
  },
};
