/**
 * slack-grok-relay — always-on Cloudflare Worker that receives Slack Events API HTTP requests
 * and forwards them to a Grok Bot inbound (routine) webhook.
 *
 * It replaces the *receiving* half of the Socket Mode bridge (../index.js) for hosts that sleep
 * or freeze when idle: Slack delivers to this Worker over HTTPS, the Worker wakes Grok, and the
 * Grok routine replies with the bot token. Same routing rules, same webhook payload and headers
 * as the bridge, so an existing wake routine needs no change.
 *
 * Secrets (wrangler secret put): SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GROK_WEBHOOK_URL,
 *                                GROK_WEBHOOK_SECRET (optional but recommended)
 * Vars (wrangler.toml [vars]):   see wrangler.toml.example
 *
 * Every request is answered fast (200 within ms); slow work runs in ctx.waitUntil so Slack's
 * 3-second deadline is never at risk.
 */

const enc = new TextEncoder();
const FORWARD_SUBTYPES = new Set(["file_share"]);
const PERSONAL_BASE_TERMS = [
  "kids?", "child", "daughter", "son", "family", "school", "calendar",
  "schedule", "class(?:es)?", "piano", "sewing", "gymnastics", "art class",
  "pickup", "carpool", "address", "home", "phone", "email",
  "where (?:is|are)", "what time", "taking",
];

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const idSet = (v) => new Set(list(v));
const isTrue = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : String(v).toLowerCase() !== "false");
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const log = (...a) => console.log(new Date().toISOString(), ...a);

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
    holdAck: isTrue(env.HOLD_ACK, true),
    holdAckBroadcast: isTrue(env.HOLD_ACK_BROADCAST, true),
    holdAckDmTopLevel: isTrue(env.HOLD_ACK_DM_TOP_LEVEL, false),
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
async function slackApi(env, method, body, { get = false } = {}) {
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
  if (!data.ok) log(`slack ${method} failed:`, data.error);
  return data;
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

async function postHoldAck(env, c, channel, threadTs, text, topLevel) {
  if (!c.holdAck || !channel || !threadTs) return;
  if (c.holdAckSkip && c.holdAckSkip.test(String(text || ""))) return log("hold-ack skipped (HOLD_ACK_SKIP_REGEX)");
  const body = c.personalRe.test(String(text || "")) ? c.holdAckPersonal : c.holdAckGeneric;
  await slackApi(env, "chat.postMessage", topLevel
    ? { channel, text: body }
    : { channel, thread_ts: threadTs, text: body, reply_broadcast: c.holdAckBroadcast }).catch(() => {});
}

// ---------------------------------------------------------------- handlers (run in waitUntil)
async function processInbound(env, c, kind, e, sayOnFail) {
  const channel = e.channel;
  const threadTs = e.thread_ts || e.ts;
  await setThinking(env, c, channel, threadTs);
  try {
    const slack = await summarizeEvent(env, e);
    await wakeGrok(env, { source: c.source, kind, slack, hold_ack: c.personalRe.test(String(slack.text || "")) ? "personal" : "generic" });
    log("wake ok", kind, channel, e.ts);
    await clearThinking(env, channel, threadTs);
    const isDm = e.channel_type === "im" || e.channel_type === "mpim";
    await postHoldAck(env, c, channel, threadTs, slack.text, c.holdAckDmTopLevel && isDm && !e.thread_ts);
  } catch (err) {
    log("wake FAILED", kind, channel, e.ts, err?.message || err);
    await clearThinking(env, channel, threadTs);
    if (sayOnFail) {
      await slackApi(env, "chat.postMessage", {
        channel, thread_ts: threadTs, text: "Could not reach Grok webhook. Check GROK_WEBHOOK_URL / secret.",
      }).catch(() => {});
    }
  }
}

async function forwardWatched(env, c, e) {
  try {
    const slack = await summarizeEvent(env, e);
    await wakeGrok(env, { source: c.source, kind: "channel_message", watched: true, slack });
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

async function handle(env, c, e, action) {
  if (action === "wake_mention") return processInbound(env, c, "app_mention", e, true);
  if (action === "wake_dm") return processInbound(env, c, "message", e, false);
  if (action === "watched") return forwardWatched(env, c, e);
  if (action === "welcome") return welcome(env, c, e);
}

// ---------------------------------------------------------------- entry
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extra } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "slack-grok-relay", configured: !!(env.SLACK_SIGNING_SECRET && env.GROK_WEBHOOK_URL && env.SLACK_BOT_TOKEN) });
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
    if (action !== "ignore") ctx.waitUntil(handle(env, c, e, action).catch((err) => log("handler error", err?.message || err)));
    return json({ ok: true }, 200, { "X-Relay-Action": `${action}:${reason}` });
  },
};
