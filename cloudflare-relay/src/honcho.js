/**
 * Honcho public-channel memory.
 *
 * Live ingest is a no-op unless HONCHO_INGEST is "1" / "true" / "yes" / "on".
 * Unset, "0", and "false" do nothing. Ingest writes only.
 *
 * Wake-path reads are a separate kill switch (HONCHO_READ, default off),
 * independent of HONCHO_INGEST. When that switch is on, this module can read:
 * one GET of the per-channel session context, attached by the caller as
 * payload.honcho. A slow or failed read returns { ok: false } and does not throw.
 *
 * Session id: one session per public Slack channel, `channel-<channelId>`.
 * Honcho ids only allow [A-Za-z0-9_-], so the id is a prefix plus the channel id,
 * not channel:id. One session keeps that room together for a later on-demand read.
 *
 * Peer id is the Slack user id (U... or W...). A log label such as "samplebot" is
 * never used as a peer id. Message content is "<author>: <text>" when a display
 * name or user id is available. slack_ts is stored on metadata.
 *
 * Channel scope: channel_type "channel" is public. A C id is not. Group DMs can
 * also use C ids. When type is missing, HONCHO_CHANNEL_IDS wins, then a working
 * conversations.info lookup. Otherwise ingest fails closed (needs-channel-type).
 *
 * Privacy: the same personal-term heuristic as looksPersonal() / the owner share
 * hold list (family, schedule, address, phone, email, ...), plus tokens, key URLs,
 * street addresses, and financial account numbers. Those messages are dropped.
 */

const HONCHO_BASE = "https://api.honcho.dev";
const ID_RE = /^[A-Za-z0-9_-]+$/;

// Keep in sync with PERSONAL_BASE_TERMS in index.js and cloudflare-relay/src/index.js.
const PERSONAL_BASE_TERMS = [
  "kids?", "child", "daughter", "son", "family", "school", "calendar",
  "schedule", "class(?:es)?", "lessons?", "practice", "activit(?:y|ies)", "sports?",
  "pickup", "carpool", "address", "home", "phone", "email",
  "where (?:is|are)", "what time", "taking",
];

const SECRET_RES = [
  /\b(?:xox[baprs]-|xapp-|xoxe\.|xoxc-)[A-Za-z0-9-]+/,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bbearer\s+[A-Za-z0-9._-]{12,}/i,
  /https?:\/\/\S*(?:token|secret|password|api[_-]?key|sig|signature)=/i,
  /hooks\.slack\.com\/services\//i,
  /files\.slack\.com\//i,
  /\burl_private\b/i,
];
const ADDRESS_RE = /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|way)\b/i;
const FINANCE_RES = [
  /\b(?:\d{4}[ -]){3}\d{4}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:bank account|routing number|credit card|debit card|social security)\b/i,
];

const HUMAN_SUBTYPES = new Set(["file_share", "slack_audio", "thread_broadcast", "me_message"]);
const OWN_SUBTYPES = new Set([...HUMAN_SUBTYPES, "bot_message"]);
const LOUD_SKIP = new Set(["personal", "secret", "address", "finance", "needs-channel-type", "not-allowlisted", "silent"]);
const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;
const lookupCache = new Map();

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createHonchoState() {
  return {
    workspace: null,
    peers: new Set(),
    sessions: new Set(),
    members: new Set(),
    seen: new Map(),
    recordReady: new Set(),
  };
}

const globalState = createHonchoState();

export function resetHonchoState() {
  globalState.workspace = null;
  globalState.peers.clear();
  globalState.sessions.clear();
  globalState.members.clear();
  globalState.seen.clear();
  globalState.recordReady = new Set();
  lookupCache.clear();
}

function stateOf(opts) {
  return opts?.state || globalState;
}

/** Live kill switch. Default off. */
export function honchoIngestEnabled(env) {
  const v = env?.HONCHO_INGEST;
  if (v === undefined || v === null || String(v).trim() === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function workspaceIdOf(env) {
  const id = String(env?.HONCHO_WORKSPACE_ID || "slack-workspace").trim();
  return id || "slack-workspace";
}

export function buildPersonalRe(extraNames) {
  const names = String(extraNames || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(escapeRegex);
  return new RegExp(`\\b(${[...names, ...PERSONAL_BASE_TERMS].join("|")})\\b`, "i");
}

/** Comma-separated Slack channel ids. Empty / unset means no allowlist. */
export function parseChannelIds(value) {
  if (value == null) return null;
  if (value instanceof Set) return value.size ? value : null;
  const ids = String(value).split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/**
 * Channels that must stay silent. Accepts the Worker env or the raw
 * SILENT_CHANNEL_IDS string. Empty / unset means no mute. This list does not
 * enable recording.
 */
export function silentChannelSet(source) {
  const value = source instanceof Set || typeof source === "string" || source == null
    ? source
    : source.SILENT_CHANNEL_IDS;
  return parseChannelIds(value) || new Set();
}

/** Slack channel id from a top-level event, an edit, a join, or a raw id string. */
export function eventChannelId(event) {
  if (typeof event === "string") return event.trim();
  if (!event || typeof event !== "object") return "";
  const values = [
    event.channel,
    event.channel_id,
    event.message?.channel,
    event.item?.channel,
    event.previous_message?.channel,
  ];
  for (const value of values) {
    const id = String(value ?? "").trim();
    if (id) return id;
  }
  return "";
}

/** True when the event's channel is listed in SILENT_CHANNEL_IDS. */
export function isSilentEvent(env, event) {
  const id = eventChannelId(event);
  if (!id) return false;
  return silentChannelSet(env).has(id);
}

export function isSlackUserId(value) {
  return SLACK_USER_ID.test(String(value || "").trim());
}

/** Built-in "samplebot" plus any extra bot labels (BOT_NAME, auth.test username). */
export function botLabelSet(extra) {
  const labels = new Set(["samplebot"]);
  const list = Array.isArray(extra) ? extra : String(extra || "").split(",");
  for (const item of list) {
    const label = String(item || "").trim().toLowerCase().replace(/^@/, "");
    if (label) labels.add(label);
  }
  return labels;
}

/**
 * Log user "samplebot" (and the same kind of bot label) becomes OWN_USER_ID.
 * Anything that is not a Slack user id and not a known bot label is refused.
 */
export function mapLogPeer(user, { ownUserId, labels } = {}) {
  const raw = String(user || "").trim();
  if (isSlackUserId(raw)) return { peerId: raw, display: null, mapped: false };
  const label = raw.toLowerCase().replace(/^@/, "");
  if (label && labels?.has(label)) {
    if (!isSlackUserId(ownUserId)) return { peerId: null, display: raw, mapped: true, reason: "no-peer" };
    return { peerId: String(ownUserId).trim(), display: raw, mapped: true };
  }
  return { peerId: null, display: raw, mapped: false, reason: "no-peer" };
}

/** Slack conversations.info channel object -> im | mpim | group | channel. */
export function channelKindFromInfo(channel) {
  if (!channel || typeof channel !== "object") return null;
  if (channel.is_im) return "im";
  if (channel.is_mpim) return "mpim";
  if (channel.is_private || channel.is_group) return "group";
  return "channel";
}

function asChannelKind(value) {
  if (value === "channel" || value === "im" || value === "mpim" || value === "group") return value;
  return channelKindFromInfo(value);
}

/**
 * Public-channel gate.
 * allowlistMode "unresolved" (live): HONCHO_CHANNEL_IDS applies only when type is missing.
 * allowlistMode "all" (backfill): when the allowlist is set, only those ids are eligible.
 * lookup(channelId) is used only when type is missing and no allowlist is set.
 * It may return a kind string or a conversations.info channel object. null means unresolved.
 */
export async function resolveIngestChannel(event, opts = {}) {
  const allowlist = opts.allowlist === undefined ? null : parseChannelIds(opts.allowlist);
  const mode = opts.allowlistMode || "unresolved";
  const sync = classifyChannelSync(event, { allowlist, allowlistMode: mode });
  if (sync) return sync;
  const channel = String(event?.channel || "");
  const cache = opts.cache || lookupCache;
  let kind = null;
  if (opts.lookup && channel) {
    if (cache.has(channel)) kind = cache.get(channel);
    else {
      try {
        kind = asChannelKind(await opts.lookup(channel));
      } catch {
        kind = null;
      }
      cache.set(channel, kind);
    }
  }
  if (kind === "im" || kind === "mpim" || kind === "group") return { ok: false, reason: "not-public" };
  if (kind === "channel") return { ok: true, event: { ...event, channel_type: "channel" } };
  return { ok: false, reason: "needs-channel-type" };
}

function classifyChannelSync(event, { allowlist, allowlistMode }) {
  if (!event || typeof event !== "object") return { ok: false, reason: "no-event" };
  const channel = String(event.channel || "");
  const ct = event.channel_type;
  if (ct === "im" || ct === "mpim" || ct === "group" || channel.startsWith("D")) {
    return { ok: false, reason: "not-public" };
  }
  if (ct === "channel") {
    if (allowlistMode === "all" && allowlist && !allowlist.has(channel)) {
      return { ok: false, reason: "not-allowlisted" };
    }
    return { ok: true, event };
  }
  if (ct) return { ok: false, reason: "not-public" };
  if (allowlist) {
    if (allowlist.has(channel)) return { ok: true, event: { ...event, channel_type: "channel" } };
    return { ok: false, reason: "not-allowlisted" };
  }
  return null;
}

export function isPublicChannel(event) {
  return event?.channel_type === "channel";
}

export function sessionIdForChannel(channelId) {
  return `channel-${channelId}`;
}

export function sensitiveReason(text) {
  const t = String(text || "");
  if (SECRET_RES.some((re) => re.test(t))) return "secret";
  if (ADDRESS_RE.test(t)) return "address";
  if (FINANCE_RES.some((re) => re.test(t))) return "finance";
  return null;
}

function isOwnOutbound(event, opts) {
  if (opts?.ownBotId && event?.bot_id && event.bot_id === opts.ownBotId) return true;
  if (opts?.ownUserId && event?.user && event.user === opts.ownUserId) return true;
  return false;
}

function subtypeAllowed(event, own) {
  const st = event?.subtype || null;
  if (!st) return true;
  return (own ? OWN_SUBTYPES : HUMAN_SUBTYPES).has(st);
}

/**
 * Sync gate used by the Worker, Socket Mode, and the backfill script.
 * Returns { ok:false, reason } or a prepared decision without display name.
 */
export function decideIngest(event, opts = {}) {
  if (!event || typeof event !== "object") return { ok: false, reason: "no-event" };
  if (event.type && event.type !== "message" && event.type !== "app_mention") {
    return { ok: false, reason: "type" };
  }
  if (!isPublicChannel(event)) return { ok: false, reason: "not-public" };
  if (event.hidden) return { ok: false, reason: "hidden" };

  const own = isOwnOutbound(event, opts);
  if (!own && (event.bot_id || event.subtype === "bot_message")) return { ok: false, reason: "bot" };
  if (!subtypeAllowed(event, own)) return { ok: false, reason: "subtype" };

  const text = String(event.text || "").trim();
  if (!text) return { ok: false, reason: "empty" };

  const personalRe = opts.personalRe || buildPersonalRe(opts.personalNames);
  if (personalRe.test(text)) return { ok: false, reason: "personal" };
  const sensitive = sensitiveReason(text);
  if (sensitive) return { ok: false, reason: sensitive };

  const peerId = String(event.user || "");
  if (!ID_RE.test(peerId)) return { ok: false, reason: "no-peer" };
  const channel = String(event.channel || "");
  if (!ID_RE.test(channel)) return { ok: false, reason: "bad-channel" };
  if (!event.ts) return { ok: false, reason: "no-ts" };

  return {
    ok: true,
    peerId,
    channel,
    sessionId: sessionIdForChannel(channel),
    text,
    ts: String(event.ts),
    threadTs: event.thread_ts || null,
    subtype: event.subtype || null,
    own,
  };
}

export function slackTsToIso(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n < 1e9) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function messageContent(text, author) {
  const body = String(text || "").trim();
  const who = String(author || "").trim();
  return who ? `${who}: ${body}` : body;
}

export async function materialize(decision, opts = {}) {
  let display = opts.displayName || null;
  if (!display && opts.resolveDisplay) {
    try {
      display = await opts.resolveDisplay(decision.peerId);
    } catch {
      display = null;
    }
  }
  display = display ? String(display).trim() : "";
  const metadata = {
    slack_ts: decision.ts,
    channel: decision.channel,
    source: "slack",
  };
  if (decision.threadTs) metadata.thread_ts = decision.threadTs;
  if (decision.subtype) metadata.subtype = decision.subtype;
  if (display) metadata.author_display = display;
  const createdAt = slackTsToIso(decision.ts);
  return {
    ...decision,
    display: display || null,
    content: messageContent(decision.text, display || decision.peerId),
    metadata,
    createdAt,
  };
}

function claim(state, channel, ts) {
  const key = `${channel}:${ts}`;
  const now = Date.now();
  if (state.seen.size > 5000) {
    for (const [k, t] of state.seen) if (now - t > 10 * 60 * 1000) state.seen.delete(k);
  }
  if (state.seen.has(key)) return false;
  state.seen.set(key, now);
  return true;
}

function unclaim(state, channel, ts) {
  state.seen.delete(`${channel}:${ts}`);
}

async function honchoPost(env, path, body, fetchImpl, method = "POST") {
  const key = env?.HONCHO_API_KEY;
  if (!key) throw new Error("honcho missing HONCHO_API_KEY");
  const base = String(env.HONCHO_API_BASE || HONCHO_BASE).replace(/\/$/, "");
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);
  const res = await fetchImpl(`${base}${path}`, init);
  if (!res.ok && res.status !== 409) throw new Error(`honcho ${res.status} ${path}`);
  return res;
}

/** Create workspace, peer, session, and membership, then post one message. */
export async function sendIngest(env, prepared, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const state = stateOf(opts);
  const ws = workspaceIdOf(env);
  if (!ID_RE.test(ws)) throw new Error("honcho bad workspace id");

  if (state.workspace !== ws) {
    await honchoPost(env, "/v3/workspaces", { id: ws }, fetchImpl);
    state.workspace = ws;
  }
  if (!state.peers.has(prepared.peerId)) {
    await honchoPost(env, `/v3/workspaces/${encodeURIComponent(ws)}/peers`, { id: prepared.peerId }, fetchImpl);
    state.peers.add(prepared.peerId);
  }
  if (!state.sessions.has(prepared.sessionId)) {
    await honchoPost(env, `/v3/workspaces/${encodeURIComponent(ws)}/sessions`, {
      id: prepared.sessionId,
      metadata: { channel: prepared.channel, source: "slack" },
    }, fetchImpl);
    state.sessions.add(prepared.sessionId);
  }
  const memberKey = `${prepared.sessionId}:${prepared.peerId}`;
  if (!state.members.has(memberKey)) {
    await honchoPost(
      env,
      `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(prepared.sessionId)}/peers`,
      { [prepared.peerId]: {} },
      fetchImpl,
    );
    state.members.add(memberKey);
  }
  const message = {
    content: prepared.content,
    peer_id: prepared.peerId,
    metadata: prepared.metadata,
  };
  if (prepared.createdAt) message.created_at = prepared.createdAt;
  await honchoPost(
    env,
    `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(prepared.sessionId)}/messages`,
    { messages: [message] },
    fetchImpl,
  );
}

/**
 * Returns null when ingest is off, filtered, or deduped.
 * Otherwise a promise that logs failures and does not reject.
 * Callers must not await this on the Slack ack or wakeGrok path.
 */
function logSkip(reason, event, opts) {
  if (!LOUD_SKIP.has(reason)) return null;
  (opts.log || console.log)("honcho skip", reason, event?.channel, event?.ts);
  return null;
}

function startWrite(env, event, opts) {
  let decision;
  try {
    decision = decideIngest(event, opts);
  } catch (err) {
    (opts.log || console.log)("honcho ingest failed", err?.message || err);
    return null;
  }
  const logFn = opts.log || console.log;
  if (!decision.ok) return logSkip(decision.reason, event, opts);
  const state = stateOf(opts);
  if (!claim(state, decision.channel, decision.ts)) return null;
  return materialize(decision, opts)
    .then((prepared) => sendIngest(env, prepared, opts))
    .then(() => {
      logFn("honcho ok", decision.channel, decision.ts);
    })
    .catch((err) => {
      unclaim(state, decision.channel, decision.ts);
      logFn("honcho ingest failed", err?.message || err, decision.channel, decision.ts);
    });
}

/**
 * Returns null when ingest is off, filtered, or deduped.
 * Otherwise a promise that logs failures and does not reject.
 * Callers must not await this on the Slack ack or wakeGrok path.
 * Channel type missing: HONCHO_CHANNEL_IDS, else opts.lookupChannel, else skip.
 */
export function ingestIfEnabled(env, event, opts = {}) {
  if (!honchoIngestEnabled(env)) return null;
  // Silent channels are not public-ingested. Recording is a separate path and
  // stays off until that path is explicitly enabled. Never fall through.
  if (isSilentEvent(env, event)) return logSkip("silent", event, opts);
  const allowlist = opts.allowlist !== undefined ? opts.allowlist : env?.HONCHO_CHANNEL_IDS;
  let sync;
  try {
    sync = classifyChannelSync(event, {
      allowlist: parseChannelIds(allowlist),
      allowlistMode: opts.allowlistMode || "unresolved",
    });
  } catch (err) {
    (opts.log || console.log)("honcho ingest failed", err?.message || err);
    return null;
  }
  if (sync) return sync.ok ? startWrite(env, sync.event, opts) : logSkip(sync.reason, event, opts);
  return resolveIngestChannel(event, { lookup: opts.lookupChannel })
    .then((resolved) => {
      if (!resolved.ok) {
        const logFn = opts.log || console.log;
        if (resolved.reason === "not-public") logFn("honcho skip", "not-public", event?.channel, event?.ts);
        return logSkip(resolved.reason, event, opts);
      }
      return startWrite(env, resolved.event, opts);
    })
    .catch((err) => {
      (opts.log || console.log)("honcho ingest failed", err?.message || err);
    });
}

/** Wake-path context kill switch. Default off. Independent of HONCHO_INGEST. */
export function honchoReadEnabled(env) {
  const v = env?.HONCHO_READ;
  if (v === undefined || v === null || String(v).trim() === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function readTimeoutMs(env) {
  const n = Number.parseInt(env?.HONCHO_READ_TIMEOUT_MS ?? "1500", 10);
  if (!Number.isFinite(n) || n < 1) return 1500;
  return Math.min(n, 15000);
}

function truncateLine(s, max = 240) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
}

function summarizeRecent(messages, limit = 8) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const out = [];
  for (const m of messages.slice(-limit)) {
    const line = truncateLine(m?.content);
    if (line) out.push(line);
  }
  return out;
}

function summaryText(summary) {
  if (!summary) return null;
  if (typeof summary === "string") return truncateLine(summary, 2000) || null;
  if (typeof summary === "object" && summary.content != null) {
    return truncateLine(summary.content, 2000) || null;
  }
  return null;
}

function errorFromCatch(err) {
  const name = err?.name || "";
  const msg = String(err?.message || err || "error");
  return name === "TimeoutError" || /aborted|timeout/i.test(msg)
    ? "timeout"
    : truncateLine(msg, 120) || "error";
}

/** One session context GET. Never throws. Always includes ms. Fail-open. */
async function fetchSessionContext(env, sessionId, opts = {}) {
  const started = Date.now();
  const done = (extra) => ({ ms: Date.now() - started, sessionId, ...extra });
  try {
    const key = env?.HONCHO_API_KEY;
    if (!key) return done({ ok: false, error: "no-key" });
    if (!sessionId || !ID_RE.test(sessionId)) return done({ ok: false, error: "bad-session" });
    const ws = workspaceIdOf(env);
    if (!ID_RE.test(ws)) return done({ ok: false, error: "bad-workspace" });

    const peer = String(opts.peer || "").trim();
    const params = new URLSearchParams();
    params.set("tokens", String(opts.tokens ?? 1200));
    params.set("summary", opts.summary === false ? "false" : "true");
    if (peer && ID_RE.test(peer)) params.set("peer_target", peer);

    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const base = String(env.HONCHO_API_BASE || HONCHO_BASE).replace(/\/$/, "");
    const path = `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sessionId)}/context?${params}`;
    const timeoutMs = opts.timeoutMs ?? readTimeoutMs(env);
    const res = await fetchImpl(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return done({ ok: false, error: `http-${res.status}` });
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") return done({ ok: false, error: "bad-json" });
    return done({
      ok: true,
      summary: summaryText(body.summary),
      peer_representation: body.peer_representation != null
        ? truncateLine(body.peer_representation, 2000)
        : null,
      peer_card: Array.isArray(body.peer_card)
        ? body.peer_card.map((x) => truncateLine(x, 200)).filter(Boolean).slice(0, 12)
        : null,
      recent: summarizeRecent(body.messages, opts.recentLimit ?? 8),
    });
  } catch (err) {
    return done({ ok: false, error: errorFromCatch(err) });
  }
}

/**
 * Session context for the wake payload. Prefer this over peer /chat (too slow).
 * Never throws. Always includes ms. Fail-open for the caller.
 * Only the per-channel session (`channel-<id>`). No extra sessions.
 */
export async function fetchWakeContext(env, { channel, user, text, channelType } = {}, opts = {}) {
  const started = Date.now();
  const done = (extra) => ({ ms: Date.now() - started, ...extra });
  try {
    const key = env?.HONCHO_API_KEY;
    if (!key) return done({ ok: false, error: "no-key" });
    const channelId = String(channel || "").trim();
    if (!channelId || !ID_RE.test(channelId)) return done({ ok: false, error: "bad-channel" });
    // Record-only sessions are never wake context. Do not name or fetch them here.
    if (isSilentEvent(env, { channel: channelId })) return done({ ok: false, error: "silent" });
    const ws = workspaceIdOf(env);
    if (!ID_RE.test(ws)) return done({ ok: false, error: "bad-workspace" });
    const sessionId = sessionIdForChannel(channelId);
    if (!ID_RE.test(sessionId)) return done({ ok: false, error: "bad-session" });

    void text;
    void channelType;

    const channelCtx = await fetchSessionContext(env, sessionId, {
      peer: String(user || "").trim(),
      tokens: opts.tokens,
      summary: opts.summary,
      recentLimit: opts.recentLimit,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? readTimeoutMs(env),
    });
    const { sessionId: _sid, ...rest } = channelCtx;
    return done({ ...rest, sessionId });
  } catch (err) {
    return done({ ok: false, error: errorFromCatch(err) });
  }
}

/**
 * Record-only storage for SILENT_CHANNEL_IDS.
 *
 * Off unless SILENT_RECORD is on. Never uses the public session `channel-<id>`
 * or the Slack user id as the Honcho peer id, so shared peer cards are not the
 * observed peer. Same workspace (no second workspace). No scopes.
 *
 * Honcho v3.6 (api.honcho.dev, deriver enqueue.py get_effective_observe_me):
 * - observe_me defaults to true. Session peer config overrides peer config.
 *   false means the deriver does not enqueue a representation for that sender.
 *   Summaries are enqueued separately and do not check observe_me.
 * - Message configuration is the highest layer. reasoning.enabled false skips
 *   reasoning for that message. Message config cannot disable summaries.
 * - Session reasoning.enabled false disables facts, representations, peer cards,
 *   and dreams. summary.enabled is independent, so it is set false here.
 * - POST get-or-create may return an existing session without applying new
 *   configuration, so the session PUT and the session-peer config PUT must
 *   succeed before the message POST. A failed setup does not fall through to
 *   sendIngest.
 *
 * Residual limit: this client cannot prove the hosted service has no other
 * workspace-wide reader. Flags plus a distinct peer id are what the API
 * actually exposes. Wake reads never request `record-<id>`.
 */

export const RECORD_SESSION_CONFIGURATION = Object.freeze({
  reasoning: Object.freeze({ enabled: false }),
  summary: Object.freeze({ enabled: false }),
  dream: Object.freeze({ enabled: false }),
  peer_card: Object.freeze({ create: false, use: false }),
});
export const RECORD_MESSAGE_CONFIGURATION = Object.freeze({
  reasoning: Object.freeze({ enabled: false }),
});
const RECORD_OBSERVE = Object.freeze({ observe_me: false, observe_others: false });

const SEARCH_INTENT_RE = /\b(search|history|transcript|recall|look[\s-]*up|what was said|what did\b|recorded|recording|messages from|channel log)\b/i;

export function silentRecordEnabled(env) {
  const v = env?.SILENT_RECORD;
  if (v === undefined || v === null || String(v).trim() === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function recordSessionIdForChannel(channelId) {
  return `record-${channelId}`;
}

export function recordPeerId(channelId, slackUserId) {
  return `rec-${channelId}-${slackUserId}`;
}

export function normalizeRecordEvent(event) {
  if (!event || typeof event !== "object") return event;
  if (event.subtype === "message_changed" && event.message && typeof event.message === "object") {
    const inner = event.message;
    const subtype = inner.subtype && inner.subtype !== "message_changed" ? inner.subtype : undefined;
    return {
      type: inner.type || "message",
      user: inner.user,
      bot_id: inner.bot_id,
      subtype,
      text: inner.text,
      ts: inner.ts || event.ts,
      thread_ts: inner.thread_ts || null,
      channel: inner.channel || event.channel || event.channel_id,
      channel_type: inner.channel_type || event.channel_type,
    };
  }
  return event;
}

/** Sync gate for record-only writes. Does not apply the public personal-term filter. */
export function decideRecordIngest(event, opts = {}) {
  const env = opts.env || opts;
  const raw = normalizeRecordEvent(event);
  if (!raw || typeof raw !== "object") return { ok: false, reason: "no-event" };
  const channel = eventChannelId(raw);
  if (!isSilentEvent(env, { channel })) return { ok: false, reason: "not-silent" };
  const ct = raw.channel_type;
  if (ct === "im" || ct === "mpim" || channel.startsWith("D")) return { ok: false, reason: "not-record-channel" };
  if (raw.type && raw.type !== "message" && raw.type !== "app_mention") return { ok: false, reason: "type" };
  if (raw.hidden) return { ok: false, reason: "hidden" };
  if (raw.bot_id || raw.subtype === "bot_message") return { ok: false, reason: "bot" };
  if (raw.subtype && !HUMAN_SUBTYPES.has(raw.subtype)) return { ok: false, reason: "subtype" };
  const text = String(raw.text || "").trim();
  if (!text) return { ok: false, reason: "empty" };
  const sensitive = sensitiveReason(text);
  if (sensitive) return { ok: false, reason: sensitive };
  const slackUserId = String(raw.user || "").trim();
  if (!isSlackUserId(slackUserId)) return { ok: false, reason: "no-peer" };
  if (!raw.ts) return { ok: false, reason: "no-ts" };
  const peerId = recordPeerId(channel, slackUserId);
  const sessionId = recordSessionIdForChannel(channel);
  if (!ID_RE.test(peerId) || !ID_RE.test(sessionId)) return { ok: false, reason: "bad-id" };
  if (peerId === slackUserId || sessionId === sessionIdForChannel(channel) || sessionId.startsWith("channel-")) {
    return { ok: false, reason: "isolation" };
  }
  return {
    ok: true,
    peerId,
    slackUserId,
    channel,
    sessionId,
    text,
    ts: String(raw.ts),
    threadTs: raw.thread_ts || null,
    subtype: raw.subtype || null,
    own: false,
  };
}

async function assertRecordIsolation(prepared) {
  if (!prepared?.peerId || prepared.peerId === prepared.slackUserId) {
    throw new Error("honcho refused shared peer");
  }
  if (!prepared.sessionId || !prepared.sessionId.startsWith("record-") || prepared.sessionId.startsWith("channel-")) {
    throw new Error("honcho refused wake session");
  }
}

/** Isolated write. Throws before the message POST if setup does not stick. */
export async function sendRecord(env, prepared, opts = {}) {
  await assertRecordIsolation(prepared);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const state = stateOf(opts);
  if (!state.recordReady) state.recordReady = new Set();
  const ws = workspaceIdOf(env);
  if (!ID_RE.test(ws)) throw new Error("honcho bad workspace id");
  if (state.workspace !== ws) {
    await honchoPost(env, "/v3/workspaces", { id: ws }, fetchImpl);
    state.workspace = ws;
  }
  const readyKey = `${prepared.sessionId}:${prepared.peerId}`;
  if (!state.recordReady.has(readyKey)) {
    await honchoPost(env, `/v3/workspaces/${encodeURIComponent(ws)}/peers`, {
      id: prepared.peerId,
      configuration: { observe_me: false },
    }, fetchImpl);
    await honchoPost(env, `/v3/workspaces/${encodeURIComponent(ws)}/sessions`, {
      id: prepared.sessionId,
      metadata: { channel: prepared.channel, source: "slack-record", isolation: "record-session" },
      configuration: RECORD_SESSION_CONFIGURATION,
      peers: { [prepared.peerId]: RECORD_OBSERVE },
    }, fetchImpl);
    const sessionPath = `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(prepared.sessionId)}`;
    await honchoPost(env, sessionPath, { configuration: RECORD_SESSION_CONFIGURATION }, fetchImpl, "PUT");
    await honchoPost(
      env,
      `${sessionPath}/peers/${encodeURIComponent(prepared.peerId)}/config`,
      RECORD_OBSERVE,
      fetchImpl,
      "PUT",
    );
    state.recordReady.add(readyKey);
  }
  const message = {
    content: prepared.content,
    peer_id: prepared.peerId,
    metadata: prepared.metadata,
    configuration: RECORD_MESSAGE_CONFIGURATION,
  };
  if (prepared.createdAt) message.created_at = prepared.createdAt;
  await honchoPost(
    env,
    `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(prepared.sessionId)}/messages`,
    { messages: [message] },
    fetchImpl,
  );
}

/**
 * Record-only ingest. Null unless SILENT_RECORD is on and the channel is muted.
 * Never calls sendIngest. Failures do not reject.
 */
export function ingestSilentIfEnabled(env, event, opts = {}) {
  if (!silentRecordEnabled(env)) return null;
  if (!isSilentEvent(env, event)) return null;
  let decision;
  try {
    decision = decideRecordIngest(event, { env });
  } catch (err) {
    (opts.log || console.log)("honcho record failed", err?.message || err);
    return null;
  }
  if (!decision.ok) return logSkip(decision.reason, event, opts);
  const state = stateOf(opts);
  if (!claim(state, decision.channel, decision.ts)) return null;
  const logFn = opts.log || console.log;
  return materialize({ ...decision, peerId: decision.slackUserId }, opts)
    .then((prepared) => {
      prepared.peerId = decision.peerId;
      prepared.slackUserId = decision.slackUserId;
      prepared.sessionId = decision.sessionId;
      prepared.metadata = {
        ...prepared.metadata,
        source: "slack-record",
        slack_user: decision.slackUserId,
        isolation: "record-session",
      };
      return sendRecord(env, prepared, opts);
    })
    .then(() => {
      logFn("honcho record ok", decision.channel, decision.ts);
    })
    .catch((err) => {
      unclaim(state, decision.channel, decision.ts);
      if (state.recordReady) state.recordReady.delete(`${decision.sessionId}:${decision.peerId}`);
      logFn("honcho record failed", err?.message || err, decision.channel, decision.ts);
    });
}

function parseScopedMap(value) {
  const map = new Map();
  for (const part of String(value || "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const id = trimmed.slice(0, idx).trim();
    const members = trimmed.slice(idx + 1).split("|").map((s) => s.trim()).filter(Boolean);
    if (id) map.set(id, new Set(members));
  }
  return map;
}

function aliasMap(env) {
  return parseScopedMap(env?.SILENT_CHANNEL_ALIASES);
}

function readerMap(env) {
  return parseScopedMap(env?.SILENT_CHANNEL_READERS);
}

function grokReaders(env) {
  return parseChannelIds(env?.SILENT_GROK_READER_IDS) || new Set();
}

/** Channel ids from SILENT_CHANNEL_IDS whose id or configured alias appears in text. */
export function namedSilentChannels(env, text) {
  const hay = String(text || "");
  const lower = hay.toLowerCase();
  const aliases = aliasMap(env);
  const found = [];
  for (const channelId of silentChannelSet(env)) {
    const names = [channelId, ...(aliases.get(channelId) || [])];
    const hit = names.some((name) => {
      const needle = String(name || "").trim().toLowerCase().replace(/^#/, "");
      return needle && lower.includes(needle);
    });
    if (hit) found.push(channelId);
  }
  return found;
}

/**
 * Explicit record search. kind "none" is not a search.
 * kind "allow" is a 1:1 DM from a configured reader naming one muted channel.
 * Anything else that names a channel with search intent is "deny" (no fetch).
 * The Slack user id is event.user, never a name typed in the text.
 */
export function classifyRecordSearch(env, event) {
  const text = String(event?.text || "");
  if (!SEARCH_INTENT_RE.test(text)) return { kind: "none" };
  const named = namedSilentChannels(env, text);
  if (!named.length) return { kind: "none" };
  if (named.length !== 1) return { kind: "deny", channelId: null };
  const channelId = named[0];
  const im = event?.channel_type === "im" && String(event?.channel || "").startsWith("D");
  const human = !!event && !event.bot_id && event.subtype !== "bot_message";
  const readers = readerMap(env).get(channelId) || new Set();
  const requesterId = String(event?.user || "");
  if (im && human && readers.has(requesterId)) {
    return { kind: "allow", channelId, requesterId, dmChannel: String(event.channel) };
  }
  return { kind: "deny", channelId, requesterId };
}

function emptyRecord(extra) {
  return {
    ok: false,
    messages: [],
    peer_representation: null,
    peer_card: null,
    summary: null,
    ...extra,
  };
}

function recordMessageView(item) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  return {
    content: truncateLine(item?.content, 400),
    author: metadata.author_display || metadata.slack_user || null,
    slack_user: metadata.slack_user || null,
    slack_ts: metadata.slack_ts || null,
    created_at: item?.created_at || null,
  };
}

/**
 * Session message list only. Does not call /context, /chat, or peer dialectic.
 * source "slack-im" re-checks the Slack event. source "owner-grok" allows only
 * SILENT_GROK_READER_IDS and does not post to Slack.
 */
export async function queryRecordSession(env, opts = {}) {
  const source = opts.source;
  let channelId = String(opts.channelId || "").trim();
  let requesterId = String(opts.requesterId || "").trim();
  if (source === "slack-im") {
    const decision = classifyRecordSearch(env, opts.event);
    if (decision.kind !== "allow") return emptyRecord({ error: "forbidden" });
    channelId = decision.channelId;
    requesterId = decision.requesterId;
  } else if (source === "owner-grok") {
    if (!requesterId || !grokReaders(env).has(requesterId)) return emptyRecord({ error: "forbidden" });
    if (!channelId || !isSilentEvent(env, { channel: channelId })) return emptyRecord({ error: "forbidden" });
  } else {
    return emptyRecord({ error: "forbidden" });
  }
  const sessionId = recordSessionIdForChannel(channelId);
  if (!sessionId.startsWith("record-") || sessionId.startsWith("channel-")) return emptyRecord({ error: "isolation" });
  const key = env?.HONCHO_API_KEY;
  if (!key) return emptyRecord({ error: "no-key", channelId, sessionId, requesterId });
  const ws = workspaceIdOf(env);
  if (!ID_RE.test(ws) || !ID_RE.test(sessionId)) return emptyRecord({ error: "bad-id", channelId, sessionId });
  try {
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const base = String(env.HONCHO_API_BASE || HONCHO_BASE).replace(/\/$/, "");
    const path = `/v3/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sessionId)}/messages/list?reverse=true`;
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) {
      return { ok: true, channelId, sessionId, requesterId, messages: [], peer_representation: null, peer_card: null, summary: null };
    }
    if (!res.ok) return emptyRecord({ error: `http-${res.status}`, channelId, sessionId, requesterId });
    const data = await res.json().catch(() => null);
    const items = Array.isArray(data) ? data : (data?.items || data?.messages || []);
    const views = (Array.isArray(items) ? items : []).map(recordMessageView).filter((m) => m.content);
    views.sort((a, b) => Number(a.slack_ts || 0) - Number(b.slack_ts || 0));
    return {
      ok: true,
      channelId,
      sessionId,
      requesterId,
      messages: views.slice(-20),
      peer_representation: null,
      peer_card: null,
      summary: null,
    };
  } catch (err) {
    return emptyRecord({ error: errorFromCatch(err), channelId, sessionId, requesterId });
  }
}

/** Owner-facing text. Ignores peer representation fields if a caller left them on. */
export function formatRecordReply(result, { label } = {}) {
  const name = label || result?.channelId || "that channel";
  if (!result?.ok) return `I couldn't read the private history for ${name}.`;
  const lines = Array.isArray(result.messages) ? result.messages : [];
  if (!lines.length) return `No recorded messages for ${name} yet.`;
  const body = lines.map((m) => {
    const who = m.author || "someone";
    const when = m.slack_ts ? `${m.slack_ts} ` : "";
    return `• ${when}${who}: ${m.content}`;
  }).join("\n");
  return `Private history for ${name} (${lines.length} latest, this session only).\n${body}`;
}
