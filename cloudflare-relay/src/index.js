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
 *                                HONCHO_API_KEY (used when HONCHO_INGEST or HONCHO_READ is on)
 * Vars (wrangler.toml [vars]):   see wrangler.toml.example
 *
 * HONCHO_INGEST defaults off. Public-channel memory writes run in ctx.waitUntil
 * and are never awaited on the wakeGrok path.
 * HONCHO_READ defaults off and is independent of ingest. When on, processInbound
 * and forwardWatched await one session context and attach payload.honcho before
 * wakeGrok. A slow or failed read still wakes (honcho.ok === false). See src/honcho.js.
 *
 * SILENT_CHANNEL_IDS (comma-separated) is a mute. Those channels get HTTP 200
 * and nothing else: no reaction, thinking status, hold-ack, welcome, wake, or
 * Honcho write. The check runs before ensureSelf and before route/handle.
 * Listing a channel does not enable recording.
 *
 * Acknowledgement is a reaction (ACK_REACTION, default white_check_mark). The text
 * hold-ack is opt-in (HOLD_ACK=true). Replies the Worker itself posts follow the
 * threading rule: plain in DMs/group DMs unless already threaded; thread +
 * reply_broadcast in channels. The same placement is sent as `reply` on the webhook.
 *
 * Every request is answered fast (200 within ms); slow work runs in ctx.waitUntil so Slack's
 * 3-second deadline is never at risk.
 */

import {
  classifyRecordSearch,
  eventChannelId,
  fetchWakeContext,
  formatRecordReply,
  honchoReadEnabled,
  ingestIfEnabled,
  ingestSilentIfEnabled,
  isSilentEvent,
  queryRecordSession,
  silentChannelSet,
} from "./honcho.js";

const enc = new TextEncoder();
const FORWARD_SUBTYPES = new Set(["file_share", "slack_audio"]);
const AUDIO_FT = new Set(["m4a", "mp3", "webm", "ogg", "wav", "mp4", "aac"]);

/** Voice clips arrive as subtype slack_audio or as files with an audio mimetype. */
export function hasAudio(e) {
  if (!e) return false;
  if (e.subtype === "slack_audio") return true;
  return Array.isArray(e.files) && e.files.some((f) => {
    const m = String(f?.mimetype || "");
    return f?.subtype === "slack_audio" || m.startsWith("audio/") || m === "video/mp4" || AUDIO_FT.has(String(f?.filetype || "").toLowerCase());
  });
}
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
    silent: silentChannelSet(env),
    welcomeText: env.WELCOME_TEXT || ":wave: Welcome, {user}! Ask me anything {ask_channel}, or @mention me in any channel I'm in.",
    askChannel: env.ASK_CHANNEL_ID || null,
    allowBotIds: idSet(env.ALLOW_BOT_IDS),
    allowBotUserIds: idSet(env.ALLOW_BOT_USER_IDS),
    botReplyCap: Number.parseInt(env.BOT_REPLY_CAP || "3", 10) || 3,
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
  // Before mention, DM, watch, welcome, and join handling. Edits and joins included.
  if (c.silent?.has(eventChannelId(e))) return { action: "ignore", reason: "silent" };
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
    // Voice clips often have an empty caption. Wake before the chatter filter.
    if (hasAudio(e)) return { action: "watched", reason: "watched-audio" };
    if (!worthForwarding(e.text, c)) return { action: "ignore", reason: "chatter" };
    return { action: "watched", reason: "watched-channel" };
  }
  if (ct !== "im" && ct !== "mpim") return { action: "ignore", reason: `channel_type:${ct}` };
  if (ct === "mpim") {
    // An explicit @mention in a group DM also arrives as app_mention; let that one wake.
    if (mentionsMe) return { action: "ignore", reason: "mention-handled-by-app_mention" };
    if (c.mpimRequireAddress && !addressesBot(e.text, c) && !hasAudio(e)) return { action: "ignore", reason: "mpim-not-addressed" };
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
/** True when a Slack Web API body targets a muted channel. Blocks reads and writes. */
export function silentSlackWriteBlocked(env, body) {
  const channel = body && typeof body === "object" ? (body.channel || body.channel_id) : "";
  return isSilentEvent(env, { channel });
}

async function slackApi(env, method, body, { get = false, quiet = false } = {}) {
  if (silentSlackWriteBlocked(env, body)) {
    log("silent channel blocked", method, body?.channel || body?.channel_id);
    return { ok: false, error: "silent_channel" };
  }
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
  if (!get && method === "chat.postMessage") {
    await noteOwnRootPost(env, body, data).catch((err) => log("sticky claim error", err?.message || err));
  }
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
  if (isSilentEvent(env, { channel })) return;
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
  const channel = payload?.slack?.channel || payload?.channel;
  if (isSilentEvent(env, { channel })) {
    log("silent channel blocked wake", channel);
    return "";
  }
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

const setThinking = (env, c, channel, threadTs) => {
  if (isSilentEvent(env, { channel })) return Promise.resolve();
  return slackApi(env, "assistant.threads.setStatus", {
    channel_id: channel, thread_ts: threadTs, status: "is thinking…", loading_messages: c.loading,
  }).catch(() => {});
};
const clearThinking = (env, channel, threadTs) => {
  if (isSilentEvent(env, { channel })) return Promise.resolve();
  return slackApi(env, "assistant.threads.setStatus", { channel_id: channel, thread_ts: threadTs, status: "" }).catch(() => {});
};

async function postHoldAck(env, c, channel, fields, text) {
  if (isSilentEvent(env, { channel })) return;
  if (!c.holdAck || !channel) return;
  if (c.holdAckSkip && c.holdAckSkip.test(String(text || ""))) return log("hold-ack skipped (HOLD_ACK_SKIP_REGEX)");
  const body = c.personalRe.test(String(text || "")) ? c.holdAckPersonal : c.holdAckGeneric;
  const placement = fields?.reply_broadcast ? { ...fields, reply_broadcast: c.holdAckBroadcast } : fields;
  await slackApi(env, "chat.postMessage", postMessageArgs(channel, body, placement)).catch(() => {});
}

// ---------------------------------------------------------------- handlers (run in waitUntil)

/** Session context for the wake payload. Fail-open: never throws. */
async function honchoForWake(env, e) {
  const honcho = await fetchWakeContext(env, {
    channel: e?.channel,
    user: e?.user,
    text: e?.text,
    channelType: e?.channel_type,
  });
  log("honcho read", honcho.ok ? "ok" : (honcho.error || "fail"), e?.channel, e?.ts, `${honcho.ms}ms`);
  return honcho;
}

async function processInbound(env, c, kind, e, sayOnFail, extra = null) {
  if (isSilentEvent(env, e)) return;
  const channel = e.channel;
  const threadTs = e.thread_ts || e.ts;
  const placement = replyFields(e);
  await addAckReaction(env, c, channel, e.ts);
  await setThinking(env, c, channel, threadTs);
  try {
    const slack = await summarizeEvent(env, e);
    const payload = {
      source: c.source,
      kind,
      slack,
      hold_ack: c.personalRe.test(String(slack.text || "")) ? "personal" : "generic",
      reply: placement,
    };
    if (honchoReadEnabled(env)) payload.honcho = await honchoForWake(env, e);
    if (extra && typeof extra === "object") Object.assign(payload, extra);
    await wakeGrok(env, payload);
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
  if (isSilentEvent(env, e)) return;
  try {
    const slack = await summarizeEvent(env, e);
    const payload = { source: c.source, kind: "channel_message", watched: true, slack, reply: replyFields(e) };
    if (honchoReadEnabled(env)) payload.honcho = await honchoForWake(env, e);
    await wakeGrok(env, payload);
    log("wake ok", "channel_message", e.channel, e.ts);
    if (hasAudio(e)) await addAckReaction(env, c, e.channel, e.ts);
  } catch (err) {
    log("wake FAILED", "channel_message", e.channel, e.ts, err?.message || err);
  }
}

/** Bot-to-bot loop cap: ignore an allow-listed bot once it has posted BOT_REPLY_CAP messages in this thread. */
async function botCapReached(env, c, e) {
  if (!e.bot_id && e.subtype !== "bot_message") return false; // humans are never capped
  const ts = e.thread_ts || e.ts;
  if (!e.thread_ts) return false; // first top-level bot message always allowed
  const r = await slackApi(env, "conversations.replies", { channel: e.channel, ts, limit: "200" }, { get: true }).catch(() => null);
  if (!r?.ok) return true; // fail closed for bots
  const n = (r.messages || []).filter((m) => m.bot_id && m.bot_id === e.bot_id).length;
  return n > c.botReplyCap;
}

async function welcome(env, c, e) {
  if (isSilentEvent(env, e)) return;
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
function scheduleSilentRecord(env, e) {
  return ingestSilentIfEnabled(env, e, {
    log: (...a) => log(...a),
    resolveDisplay: async (userId) => {
      const u = await resolveUser(env, userId);
      return u?.display_name || u?.real_name || u?.name || null;
    },
  });
}

async function deliverRecordSearch(env, event, decision) {
  if (!decision || decision.kind !== "allow") return;
  const dm = String(event?.channel || "");
  if (event?.channel_type !== "im" || !dm.startsWith("D")) return;
  if (isSilentEvent(env, event) || dm === decision.channelId) return;
  const result = await queryRecordSession(env, { source: "slack-im", event });
  const text = formatRecordReply(result, { label: decision.channelId });
  await slackApi(env, "chat.postMessage", { channel: dm, text });
  log("record search posted", decision.channelId, decision.requesterId, result.ok ? (result.messages || []).length : (result.error || "fail"));
}

function scheduleHoncho(env, c, e) {
  if (isSilentEvent(env, e)) return null;
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

// Sticky thread ownership. A human mention of only this bot marks the thread.
// A root message from this bot does too (it started the thread). A reply posted
// into an existing thread does not. Later untagged human replies wake with
// sticky:true. Other tags wake with sticky_other_tag and do not clear the mark.
// Bot messages never wake. An existing mark is not replaced by a later claim.
// STICKY_THREADS=0/false/off disables. TTL is 7 days.
const STICKY_TTL_SECONDS = 7 * 24 * 3600;
const STICKY_OWN_SUBTYPES = new Set(["bot_message", "file_share", "slack_audio"]);
export function stickyEnabled(env) {
  const v = String(env?.STICKY_THREADS ?? "1").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}
export function taggedUserIds(text) {
  return [...String(text || "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
}
const stickyKey = (channel, root) => `sticky:${channel}:${root}`;
function isOwnEvent(e, c) {
  if (!e || !c) return false;
  if (c.ownBotId && e.bot_id && e.bot_id === c.ownBotId) return true;
  if (c.ownUserId && e.user && e.user === c.ownUserId) return true;
  return false;
}
export function stickyOp(e, c) {
  if (!e || !c?.ownUserId || !e.channel) return { op: null };
  const isApp = e.type === "app_mention";
  if (!isApp && e.type !== "message") return { op: null };
  if (!isApp && e.channel_type !== "channel" && e.channel_type !== "group") return { op: null };
  if (String(e.channel).startsWith("D")) return { op: null };
  if (isOwnEvent(e, c)) {
    if (isApp) return { op: null };
    if (e.subtype && !STICKY_OWN_SUBTYPES.has(e.subtype)) return { op: null };
    if (!e.ts || (e.thread_ts && e.thread_ts !== e.ts)) return { op: null };
    return { op: "claim", root: e.ts };
  }
  if (e.bot_id || !e.user) return { op: null };
  if (e.subtype && !FORWARD_SUBTYPES.has(e.subtype) && e.subtype !== "slack_audio") return { op: null };
  const root = e.thread_ts || e.ts;
  const tags = [...new Set(taggedUserIds(e.text))];
  const hasMe = tags.includes(c.ownUserId);
  const other = tags.some((u) => u !== c.ownUserId);
  if (hasMe) return { op: other ? null : "set", root };
  if (isApp) return { op: null };
  if (e.thread_ts && e.thread_ts !== e.ts) return { op: "check", root, otherTag: other };
  return { op: null };
}
async function putSticky(env, key, record) {
  await env.PRIVROOM_STATE.put(key, JSON.stringify(record), { expirationTtl: STICKY_TTL_SECONDS });
}
async function applySticky(env, c, e) {
  if (!stickyEnabled(env) || !env.PRIVROOM_STATE) return;
  if (isSilentEvent(env, e)) return;
  const { op, root, otherTag } = stickyOp(e, c);
  if (!op) return;
  const key = stickyKey(e.channel, root);
  if (op === "claim") {
    if (await env.PRIVROOM_STATE.get(key)) return;
    await putSticky(env, key, { by: c.ownUserId, at: Date.now(), via: "bot" });
    return log("sticky claim", e.channel, root);
  }
  if (op === "set") {
    await putSticky(env, key, { by: e.user, at: Date.now(), via: "mention" });
    return log("sticky set", e.channel, root);
  }
  if (!(await env.PRIVROOM_STATE.get(key))) return;
  log("sticky wake", e.channel, root, e.ts);
  await processInbound(env, c, "app_mention", e, true, otherTag ? { sticky: true, sticky_other_tag: true } : { sticky: true });
}

/** Claim a thread this Worker just opened. Threaded posts, DMs, and muted channels do not claim. An existing mark is left as it is. */
export async function noteOwnRootPost(env, body, result) {
  if (!stickyEnabled(env) || !env?.PRIVROOM_STATE) return;
  if (!result?.ok || !result.ts || !body || typeof body !== "object") return;
  if (body.thread_ts) return;
  const channel = String(body.channel || "");
  if (!channel || channel.startsWith("D")) return;
  if (isSilentEvent(env, { channel })) return;
  const key = stickyKey(channel, result.ts);
  if (await env.PRIVROOM_STATE.get(key)) return;
  // Identity comes from OWN_USER_ID or an earlier auth.test. Do not call
  // ensureSelf here: muted events must stay ahead of auth.test, and the
  // Slack echo of this post claims once the event path has resolved it.
  const c = cfg(env);
  if (!c.ownUserId) return;
  await putSticky(env, key, { by: c.ownUserId, at: Date.now(), via: "send" });
  log("sticky claim", channel, result.ts);
}

// Private-room synthesize roster. Empty unless PRIVROOM_BOTS is set.
// JSON: [{"name":"BotA","userId":"U...","botId":"B..."}]. Bad JSON matches nobody.
export function privroomBotsOf(env) {
  const raw = env?.PRIVROOM_BOTS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return [];
  let arr;
  try { arr = JSON.parse(String(raw)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter((b) => b && b.name && (b.userId || b.botId)).map((b) => ({
    name: String(b.name),
    userId: b.userId ? String(b.userId) : "",
    botId: b.botId ? String(b.botId) : "",
  }));
}
function privroomDelaySeconds(env) {
  const n = Number.parseInt(env?.PRIVROOM_DELAY_SECONDS ?? "300", 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}
function privroomTags(env) {
  const custom = String(env?.PRIVROOM_MENTION_TAGS || "").trim();
  if (custom) return custom;
  return privroomBotsOf(env).map((b) => b.userId).filter(Boolean).map((id) => `<@${id}>`).join(" ");
}
export function privroomSynthEnabled(env) {
  const v = String(env?.PRIVROOM_SYNTHESIZE ?? "1").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}
export function matchPrivroomBot(e, env) {
  if (!e) return null;
  for (const b of privroomBotsOf(env)) {
    if (e.bot_id && b.botId && e.bot_id === b.botId) return b;
    if (e.user && b.userId && e.user === b.userId) return b;
  }
  return null;
}
function privroomKey(channel, ts) {
  return `privroom:${channel}:${ts}`;
}
function missingNameSlots(names, replied) {
  const left = names.slice();
  for (const name of replied || []) {
    const i = left.indexOf(name);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
}
async function armPrivroomSynth(env, { channel, ts, invoker, question }) {
  if (!privroomSynthEnabled(env)) return;
  if (!env.PRIVROOM_STATE || !env.PRIVROOM_SYNTH) {
    log("privroom synth skipped: missing PRIVROOM_STATE or PRIVROOM_SYNTH binding");
    return;
  }
  const record = { channel, ts, invoker, question, replied: [], seen: [], synthesized: false, createdAt: Date.now() };
  await env.PRIVROOM_STATE.put(privroomKey(channel, ts), JSON.stringify(record), { expirationTtl: 7200 });
  await env.PRIVROOM_SYNTH.send({ channel, ts }, { delaySeconds: privroomDelaySeconds(env) });
  log("privroom armed", channel, ts, `delay=${privroomDelaySeconds(env)}s`);
}
async function claimPrivroomSynth(env, channel, ts, reason) {
  if (!env.PRIVROOM_STATE) return null;
  const key = privroomKey(channel, ts);
  const lockKey = `privroom:lock:${channel}:${ts}`;
  if (await env.PRIVROOM_STATE.get(lockKey)) return null;
  await env.PRIVROOM_STATE.put(lockKey, reason || "claimed", { expirationTtl: 7200 });
  const raw = await env.PRIVROOM_STATE.get(key);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (rec.synthesized) return null;
  rec.synthesized = true;
  rec.synthesizedAt = Date.now();
  rec.reason = reason || "unknown";
  await env.PRIVROOM_STATE.put(key, JSON.stringify(rec), { expirationTtl: 7200 });
  return rec;
}
export function buildPrivroomSynthPayload(env, rec, reason) {
  const replied = Array.isArray(rec.replied) ? rec.replied : [];
  const names = privroomBotsOf(env).map((b) => b.name);
  return {
    source: env.BRIDGE_SOURCE || env.source || "slack-bridge-example",
    kind: "privroom_synthesize",
    channel: rec.channel,
    thread_ts: rec.ts,
    question: rec.question,
    invoker: rec.invoker,
    replied,
    missing: missingNameSlots(names, replied),
    reason: reason || rec.reason || null,
  };
}
async function firePrivroomSynthesize(env, rec, reason) {
  const payload = buildPrivroomSynthPayload(env, rec, reason);
  if (String(env.PRIVROOM_SYNTH_DRY_RUN || "") === "1") {
    log("privroom synthesize DRY_RUN", reason, rec.channel, rec.ts);
    return payload;
  }
  await wakeGrok(env, payload);
  log("privroom synthesize wake", reason, rec.channel, rec.ts);
  return payload;
}
async function tryPrivroomSynthesize(env, channel, ts, reason) {
  if (!privroomSynthEnabled(env)) return false;
  const rec = await claimPrivroomSynth(env, channel, ts, reason);
  if (!rec) return false;
  try {
    await firePrivroomSynthesize(env, rec, reason);
    return true;
  } catch (err) {
    log("privroom synthesize wake FAILED", reason, channel, ts, err?.message || err);
    try {
      await env.PRIVROOM_STATE.delete(`privroom:lock:${channel}:${ts}`);
      const key = privroomKey(channel, ts);
      const raw = await env.PRIVROOM_STATE.get(key);
      if (raw) {
        const row = JSON.parse(raw);
        row.synthesized = false;
        delete row.synthesizedAt;
        delete row.reason;
        await env.PRIVROOM_STATE.put(key, JSON.stringify(row), { expirationTtl: 7200 });
      }
    } catch { /* unlock is best-effort */ }
    throw err;
  }
}
async function onPrivroomBotReply(env, e, bot) {
  if (!privroomSynthEnabled(env) || !env.PRIVROOM_STATE) return;
  const threadTs = e.thread_ts;
  if (!threadTs || threadTs === e.ts) return;
  const key = privroomKey(e.channel, threadTs);
  const raw = await env.PRIVROOM_STATE.get(key);
  if (!raw) return;
  let rec;
  try { rec = JSON.parse(raw); } catch { return; }
  if (rec.synthesized) return;
  const seen = Array.isArray(rec.seen) ? rec.seen.slice() : [];
  const id = `${bot.userId || ""}:${bot.botId || ""}`;
  if (seen.includes(id)) return;
  seen.push(id);
  const names = privroomBotsOf(env).map((b) => b.name);
  const replied = Array.isArray(rec.replied) ? rec.replied.slice() : [];
  if (missingNameSlots(names, replied).includes(bot.name)) replied.push(bot.name);
  rec.replied = replied;
  rec.seen = seen;
  await env.PRIVROOM_STATE.put(key, JSON.stringify(rec), { expirationTtl: 7200 });
  log("privroom reply noted", bot.name, e.channel, threadTs);
  if (missingNameSlots(names, replied).length === 0) {
    await tryPrivroomSynthesize(env, e.channel, threadTs, "all_replied");
  }
}
async function handleCommand(request, env, ctx) {
  if (!env.SLACK_SIGNING_SECRET) return json({ ok: false, error: "signing secret not configured" }, 503);
  const raw = await request.text();
  const bad = await verifySlack(request, raw, env.SLACK_SIGNING_SECRET);
  if (bad) return json({ ok: false, error: bad }, 401);
  const f = new URLSearchParams(raw);
  if (f.get("command") !== "/privroom") return json({ response_type: "ephemeral", text: "Unknown command" });
  const text = (f.get("text") || "").trim();
  if (!text) return json({ response_type: "ephemeral", text: "Usage: /privroom <question>" });
  const channel = f.get("channel_id");
  const user = f.get("user_id");
  if (isSilentEvent(env, { channel })) return json({ response_type: "ephemeral", text: "This channel is muted." });
  const msg = `${privroomTags(env)} from: <@${user}>. ${text}`.trim();
  const r = await slackApi(env, "chat.postMessage", { channel, text: msg });
  if (!r?.ok || !r.ts) return json({ response_type: "ephemeral", text: "Could not post." });
  if (ctx && privroomSynthEnabled(env)) {
    ctx.waitUntil(armPrivroomSynth(env, { channel, ts: r.ts, invoker: user, question: text }).catch((err) => log("privroom arm error", err?.message || err)));
  }
  return json({ response_type: "ephemeral", text: "Sent" });
}

async function handle(env, c, e, action) {
  if (isSilentEvent(env, e)) return;
  if (action === "welcome") return welcome(env, c, e);
  if (action === "wake_mention" && await botCapReached(env, c, e)) {
    log("bot reply cap reached; ignoring", e.bot_id, e.channel, e.thread_ts);
    return;
  }
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
      return json({
        ok: true,
        service: "slack-bridge-example",
        configured: !!(env.SLACK_SIGNING_SECRET && env.GROK_WEBHOOK_URL && env.SLACK_BOT_TOKEN),
        privroom_synthesize: privroomSynthEnabled(env),
      });
    }
    if (request.method === "POST" && url.pathname === "/internal/privroom-selftest") {
      if (String(env.PRIVROOM_SELFTEST || "") !== "1") return json({ ok: false, error: "selftest disabled" }, 404);
      const auth = request.headers.get("Authorization") || "";
      const secret = env.GROK_WEBHOOK_SECRET || "";
      if (!secret || auth !== `Bearer ${secret}`) return json({ ok: false, error: "unauthorized" }, 401);
      return json({ ok: false, error: "selftest disabled" }, 404);
    }
    if (request.method === "POST" && url.pathname === "/slack/commands") return handleCommand(request, env, ctx);
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

    // Mute before auth.test, ack, thinking, hold-ack, welcome, wake, or public ingest.
    // Covers app_mention (including edited), message, message_changed, joins,
    // member_joined_channel, threads, and retries. HTTP 200 is the Slack
    // protocol ack only. Optional SILENT_RECORD writes an isolated Honcho
    // session and never attaches it to a wake.
    if (isSilentEvent(env, body.event)) {
      const e = body.event;
      log("silent", body.event_id, e?.type, e?.subtype || "", eventChannelId(e), e?.ts || e?.message?.ts || "", e?.edited ? "edited" : "");
      const recordTask = scheduleSilentRecord(env, e);
      if (recordTask) ctx.waitUntil(recordTask);
      return json({ ok: true, action: "ignore", reason: "silent" }, 200, { "X-Relay-Action": "ignore:silent" });
    }

    // Explicit 1:1 search only. A deny or a normal DM does not fetch record sessions.
    const search = classifyRecordSearch(env, body.event);
    if (search.kind === "allow") {
      log("record search", search.channelId, search.requesterId, body.event?.channel);
      ctx.waitUntil(deliverRecordSearch(env, body.event, search).catch((err) => log("record search failed", err?.message || err)));
      return json({ ok: true, action: "record_search", reason: "im" }, 200, { "X-Relay-Action": "record-search:im" });
    }

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
    // Ingest is not on the wake path. Slack is acked below whether or not it runs.
    // HONCHO_READ, when on, runs inside the waitUntil handlers before wakeGrok.
    // message.channels must be subscribed or ordinary public messages never arrive.
    const honchoTask = scheduleHoncho(env, c, e);
    if (action !== "ignore") ctx.waitUntil(handle(env, c, e, action).catch((err) => log("handler error", err?.message || err)));
    if (honchoTask) ctx.waitUntil(honchoTask);
    if (stickyEnabled(env) && env.PRIVROOM_STATE && action === "ignore") {
      ctx.waitUntil(applySticky(env, c, e).catch((err) => log("sticky error", err?.message || err)));
    } else if (stickyEnabled(env) && env.PRIVROOM_STATE && e?.type === "app_mention") {
      ctx.waitUntil(applySticky(env, c, e).catch((err) => log("sticky error", err?.message || err)));
    }
    if (privroomSynthEnabled(env) && e && e.type === "message" && e.thread_ts && e.thread_ts !== e.ts) {
      const bot = matchPrivroomBot(e, env);
      if (bot) ctx.waitUntil(onPrivroomBotReply(env, e, bot).catch((err) => log("privroom reply error", err?.message || err)));
    }
    return json({ ok: true }, 200, { "X-Relay-Action": `${action}:${reason}` });
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        if (!privroomSynthEnabled(env)) { msg.ack(); continue; }
        const body = msg.body || {};
        if (!body.channel || !body.ts) { msg.ack(); continue; }
        await tryPrivroomSynthesize(env, body.channel, body.ts, "timer");
        msg.ack();
      } catch (err) {
        log("privroom queue error", err?.message || err);
        msg.retry();
      }
    }
  },
};
