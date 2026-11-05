/**
 * Honcho phase A: fire-and-forget public-channel memory writes.
 *
 * Live ingest is a no-op unless HONCHO_INGEST is "1" / "true" / "yes" / "on".
 * Unset, "0", and "false" do nothing. This module never reads Honcho.
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
const LOUD_SKIP = new Set(["personal", "secret", "address", "finance", "needs-channel-type", "not-allowlisted"]);
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
  };
}

const globalState = createHonchoState();

export function resetHonchoState() {
  globalState.workspace = null;
  globalState.peers.clear();
  globalState.sessions.clear();
  globalState.members.clear();
  globalState.seen.clear();
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

async function honchoPost(env, path, body, fetchImpl) {
  const key = env?.HONCHO_API_KEY;
  if (!key) throw new Error("honcho missing HONCHO_API_KEY");
  const base = String(env.HONCHO_API_BASE || HONCHO_BASE).replace(/\/$/, "");
  const res = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
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
