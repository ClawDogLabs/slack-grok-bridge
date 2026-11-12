#!/usr/bin/env node
// Backfill allowlisted bot replies (own + HONCHO_BOT_INGEST_IDS) from Slack history
// of HONCHO_CHANNEL_IDS into Honcho. Dedupes against existing session messages by slack_ts.
// Usage: node --env-file=.env scripts/honcho-bot-backfill.mjs [--write]
import {
  decideIngest, materialize, sendIngest, createHonchoState, resolveIngestChannel,
  privateChannelsOf, parseChannelIds, buildPersonalRe, botIngestSetOf, isSilentEvent,
} from "../cloudflare-relay/src/honcho.js";

const env = process.env;
const write = process.argv.includes("--write");
const BASE = (env.HONCHO_API_BASE || "https://api.honcho.dev").replace(/\/$/, "");
const WS = env.HONCHO_WORKSPACE_ID || "slack-workspace";
const channels = [...(parseChannelIds(env.HONCHO_CHANNEL_IDS) || [])];
const botIds = botIngestSetOf(env);
const ownUserId = env.OWN_USER_ID, ownBotId = env.OWN_BOT_ID;
const personalRe = buildPersonalRe(env.PERSONAL_NAMES);

async function slack(method, params) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 2) * 1000)); continue; }
    return res.json();
  }
  return { ok: false, error: "ratelimited" };
}
async function allPages(method, params, key = "messages") {
  const out = []; let cursor;
  do {
    const d = await slack(method, { ...params, limit: "200", ...(cursor ? { cursor } : {}) });
    if (!d.ok) { console.error(method, params.channel, d.error); break; }
    out.push(...(d[key] || []));
    cursor = d.response_metadata?.next_cursor;
  } while (cursor);
  return out;
}
async function honcho(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { Authorization: `Bearer ${env.HONCHO_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!res.ok) throw new Error(`honcho ${res.status} ${path.split("?")[0]}`);
  return res.json();
}
async function existingTs(sessionId) {
  const set = new Set(); let page = 1, pages = 1;
  do {
    let d;
    try { d = await honcho(`/v3/workspaces/${WS}/sessions/${sessionId}/messages/list?page=${page}&size=100`, {}); }
    catch (e) { if (String(e.message).includes("404")) return set; throw e; }
    for (const m of d.items || []) if (m.metadata?.slack_ts) set.add(String(m.metadata.slack_ts));
    pages = d.pages || 1; page++;
  } while (page <= pages);
  return set;
}
const names = new Map();
async function displayOf(m) {
  if (m.user) {
    if (!names.has(m.user)) {
      const d = await slack("users.info", { user: m.user });
      names.set(m.user, d.ok ? (d.user.profile?.display_name || d.user.real_name || d.user.name) : null);
    }
    return names.get(m.user) || m.bot_profile?.name || null;
  }
  return m.bot_profile?.name || m.username || null;
}

const isBot = (m) => !!m.bot_id || m.subtype === "bot_message";
const summary = {}; const state = createHonchoState(); let wrote = 0, accepted = 0;
const byPeer = {};
for (const ch of channels) {
  const s = (summary[ch] = { fetched: 0, bot: 0, accepted: 0, existing: 0, skipped: {} });
  if (isSilentEvent(env, { channel: ch })) { s.skipped.silent = 1; continue; }
  const top = await allPages("conversations.history", { channel: ch });
  const msgs = [...top];
  for (const m of top) if (m.reply_count && m.thread_ts) {
    const r = await allPages("conversations.replies", { channel: ch, ts: m.thread_ts });
    msgs.push(...r.filter((x) => x.ts !== m.ts));
  }
  s.fetched = msgs.length;
  const seen = new Set();
  const have = await existingTs(`channel-${ch}`);
  for (const m of msgs.sort((a, b) => Number(a.ts) - Number(b.ts))) {
    if (!isBot(m) || seen.has(m.ts)) continue;
    seen.add(m.ts);
    s.bot++;
    const ev = { type: "message", user: m.user, bot_id: m.bot_id, subtype: m.subtype, channel: ch, ts: m.ts, thread_ts: m.thread_ts, text: m.text, hidden: m.hidden };
    const resolved = await resolveIngestChannel(ev, { allowlist: parseChannelIds(env.HONCHO_CHANNEL_IDS), allowlistMode: "all", privateChannels: privateChannelsOf(env) });
    if (!resolved.ok) { s.skipped[resolved.reason] = (s.skipped[resolved.reason] || 0) + 1; continue; }
    const d = decideIngest(resolved.event, { ownUserId, ownBotId, botIds, personalRe });
    if (!d.ok) { s.skipped[d.reason] = (s.skipped[d.reason] || 0) + 1; continue; }
    if (have.has(String(m.ts))) { s.existing++; continue; }
    const p = await materialize(d, { displayName: await displayOf(m) });
    s.accepted++; accepted++;
    byPeer[p.peerId] = (byPeer[p.peerId] || 0) + 1;
    if (write) { await sendIngest(env, p, { state }); wrote++; }
  }
}
console.log(JSON.stringify({ write, accepted, wrote, byPeer, summary }, null, 1));
