#!/usr/bin/env node
/**
 * Replay log/raw/*.jsonl into Honcho in Slack ts order.
 *
 * Uses the same public-channel and privacy filters as live ingest.
 * Does not start the Worker. Does not read Honcho.
 *
 * Live ingest stays off until HONCHO_INGEST=1 on the bridge. This script does
 * not check that switch: --dry-run (the default) only prints, and --write posts.
 *
 *   node --env-file=.env scripts/honcho-backfill.mjs --dry-run
 *   node --env-file=.env scripts/honcho-backfill.mjs --dry-run --channel-ids C0123,C0456
 *   node --env-file=.env scripts/honcho-backfill.mjs --write
 *   node --env-file=.env scripts/honcho-backfill.mjs --write --dir log/raw
 *
 * Channel classification when channel_type is missing (a C id is not enough;
 * group DMs can use C ids). Order:
 *   1. HONCHO_CHANNEL_IDS or --channel-ids: only those ids are eligible.
 *   2. Else conversations.info (SLACK_BOT_TOKEN), skip im / mpim / private / group.
 *   3. Else skip needs-channel-type. Never treat every C id as public.
 * conversations.info currently returns missing_scope without channels:read.
 * Set the allowlist until that scope exists. Rows that already have
 * channel_type are still filtered (im / mpim / group dropped). With an
 * allowlist set, ids outside the list are skipped even if typed public.
 *
 * Log user "samplebot" (and BOT_NAME / the auth.test username) is stored as
 * OWN_USER_ID, or auth.test user_id when OWN_USER_ID is unset. Never the
 * label string.
 *
 * Required for --write: HONCHO_API_KEY.
 * Optional: HONCHO_WORKSPACE_ID (default slack-workspace), PERSONAL_NAMES,
 *           HONCHO_CHANNEL_IDS, SLACK_BOT_TOKEN, OWN_USER_ID, BOT_NAME.
 *
 * Log lines are the relay log (docs/MESSAGE_LOG.md). Re-running --write can
 * duplicate messages already stored in Honcho.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  decideIngest,
  materialize,
  sendIngest,
  buildPersonalRe,
  createHonchoState,
  resolveIngestChannel,
  parseChannelIds,
  mapLogPeer,
  botLabelSet,
  isSlackUserId,
  isSilentEvent,
} from "../cloudflare-relay/src/honcho.js";

export function loadLogEntries(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  const rows = [];
  let ord = 0;
  for (const name of files) {
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      ord += 1;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === "object") rows.push({ ...row, _ord: ord, _file: name });
      } catch {
        rows.push({ _bad: true, _ord: ord, _file: name });
      }
    }
  }
  const tsNum = (row) => {
    const n = Number(row.ts);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  rows.sort((a, b) => {
    const dt = tsNum(a) - tsNum(b);
    if (dt !== 0) return dt;
    return a._ord - b._ord;
  });
  return rows;
}

function eventFromRow(row) {
  return {
    type: "message",
    user: row.user,
    bot_id: row.bot_id,
    subtype: row.subtype,
    channel: row.channel,
    channel_type: row.channel_type,
    ts: row.ts,
    thread_ts: row.thread_ts,
    text: row.text,
  };
}

function bump(skipped, reason) {
  skipped[reason] = (skipped[reason] || 0) + 1;
}

async function slackGet(token, method, params, fetchImpl) {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const res = await fetchImpl(`https://slack.com/api/${method}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json().catch(() => ({ ok: false, error: "bad-json" }));
}

async function loadIdentity(env, fetchImpl, box) {
  if (box.ready) return box;
  const labels = botLabelSet(env.BOT_NAME || "");
  let userId = env.OWN_USER_ID || null;
  let botId = env.OWN_BOT_ID || null;
  if (env.SLACK_BOT_TOKEN && fetchImpl) {
    const data = await slackGet(env.SLACK_BOT_TOKEN, "auth.test", null, fetchImpl).catch(() => null);
    if (data?.ok) {
      if (!isSlackUserId(userId) && isSlackUserId(data.user_id)) userId = data.user_id;
      if (data.bot_id) botId = botId || data.bot_id;
      if (data.user) labels.add(String(data.user).trim().toLowerCase().replace(/^@/, ""));
    }
  }
  box.ready = true;
  box.userId = isSlackUserId(userId) ? userId : null;
  box.botId = botId || null;
  box.labels = labels;
  return box;
}

async function peerForRow(row, env, fetchImpl, box) {
  const raw = String(row.user || "").trim();
  if (isSlackUserId(raw)) return { peerId: raw, display: null };
  const early = botLabelSet(env.BOT_NAME || "");
  if (early.has(raw.toLowerCase().replace(/^@/, "")) && isSlackUserId(env.OWN_USER_ID || "")) {
    return { peerId: env.OWN_USER_ID, display: raw };
  }
  const identity = await loadIdentity(env, fetchImpl, box);
  const mapped = mapLogPeer(raw, { ownUserId: identity.userId, labels: identity.labels });
  if (!mapped.peerId) return { peerId: null };
  return { peerId: mapped.peerId, display: mapped.display };
}

/**
 * @param {{ dir?: string, entries?: object[], dryRun?: boolean, write?: boolean, env?: object, fetchImpl?: Function, ownUserId?: string, ownBotId?: string, channelIds?: string }} opts
 * channelIds overrides HONCHO_CHANNEL_IDS for this run when provided.
 */
export async function backfillLogs(opts = {}) {
  const env = opts.env || process.env;
  const dryRun = opts.write ? false : true;
  const entries = opts.entries || loadLogEntries(opts.dir || "log/raw");
  const personalRe = buildPersonalRe(env.PERSONAL_NAMES);
  const skipped = {};
  const accepted = [];
  const seen = new Set();
  const state = createHonchoState();
  const identity = { ready: false, userId: null, botId: null, labels: botLabelSet(env.BOT_NAME || "") };
  const allowSource = opts.channelIds !== undefined ? opts.channelIds : env.HONCHO_CHANNEL_IDS;
  const allowlist = parseChannelIds(allowSource);
  const channelCache = new Map();
  const slackCalls = new Map();

  async function lookup(channel) {
    if (!env.SLACK_BOT_TOKEN || !opts.fetchImpl) return null;
    if (slackCalls.has(channel)) return slackCalls.get(channel);
    const data = await slackGet(env.SLACK_BOT_TOKEN, "conversations.info", { channel }, opts.fetchImpl).catch(() => null);
    const channelObj = data?.ok ? data.channel : null;
    slackCalls.set(channel, channelObj);
    return channelObj;
  }

  for (const row of entries) {
    if (row._bad) {
      bump(skipped, "bad-json");
      continue;
    }
    // Muted channels are not public-ingested, even if the allowlist names them.
    if (isSilentEvent(env, eventFromRow(row))) {
      bump(skipped, "silent");
      continue;
    }
    const resolved = await resolveIngestChannel(eventFromRow(row), {
      allowlist,
      allowlistMode: "all",
      lookup: allowlist ? null : lookup,
      cache: channelCache,
    });
    if (!resolved.ok) {
      bump(skipped, resolved.reason);
      continue;
    }
    const peer = await peerForRow(row, env, opts.fetchImpl, identity);
    if (!peer.peerId) {
      bump(skipped, "no-peer");
      continue;
    }
    const decision = decideIngest(
      { ...resolved.event, user: peer.peerId },
      {
        personalRe,
        ownUserId: opts.ownUserId || identity.userId || env.OWN_USER_ID,
        ownBotId: opts.ownBotId || identity.botId || env.OWN_BOT_ID,
      },
    );
    if (!decision.ok) {
      bump(skipped, decision.reason);
      continue;
    }
    const key = `${decision.channel}:${decision.ts}`;
    if (seen.has(key)) {
      bump(skipped, "duplicate");
      continue;
    }
    seen.add(key);
    const displayName = row.user_display_name || row.display_name || peer.display || null;
    const prepared = await materialize(decision, { displayName });
    accepted.push(prepared);
    if (!dryRun) await sendIngest(env, prepared, { fetchImpl: opts.fetchImpl, state });
  }

  return { dryRun, accepted, skipped, wrote: dryRun ? 0 : accepted.length, slackLookups: slackCalls.size };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const write = process.argv.includes("--write");
  const dir = argValue("--dir") || "log/raw";
  if (write && !process.env.HONCHO_API_KEY) {
    console.error("honcho backfill: HONCHO_API_KEY is required for --write");
    process.exit(1);
  }
  if (!fs.existsSync(dir)) {
    console.error(`honcho backfill: no directory ${dir}`);
    process.exit(0);
  }
  const channelIds = argValue("--channel-ids");
  const result = await backfillLogs({
    dir,
    write,
    env: process.env,
    channelIds: channelIds === null ? undefined : channelIds,
  });
  if (result.dryRun) {
    for (const row of result.accepted) {
      process.stdout.write(JSON.stringify({
        session_id: row.sessionId,
        peer_id: row.peerId,
        content: row.content,
        metadata: row.metadata,
        created_at: row.createdAt,
      }) + "\n");
    }
  }
  const skipBits = Object.entries(result.skipped).map(([k, n]) => `${k}=${n}`).join(" ");
  console.error(
    `honcho backfill: accepted=${result.accepted.length} wrote=${result.wrote} dry_run=${result.dryRun}`
    + (skipBits ? ` skipped ${skipBits}` : ""),
  );
  if (!write) {
    console.error("honcho backfill: dry-run only. Pass --write to POST to Honcho. Live ingest stays off until HONCHO_INGEST=1.");
  } else if (!honchoLiveOn()) {
    console.error("honcho backfill: wrote history. HONCHO_INGEST is still off, so the live bridge will not ingest.");
  }
}

function honchoLiveOn() {
  const s = String(process.env.HONCHO_INGEST ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("honcho backfill failed", err?.message || err);
    process.exit(1);
  });
}
