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
 *   node --env-file=.env scripts/honcho-backfill.mjs --write
 *   node --env-file=.env scripts/honcho-backfill.mjs --write --dir log/raw
 *
 * Required for --write: HONCHO_API_KEY.
 * Optional: HONCHO_WORKSPACE_ID (default slack-workspace), PERSONAL_NAMES.
 *
 * Log lines are the relay log (docs/MESSAGE_LOG.md): channel, channel_type,
 * ts, user, text. DMs and group DMs are skipped. Re-running --write can
 * duplicate messages already stored in Honcho.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decideIngest, materialize, sendIngest, buildPersonalRe, createHonchoState } from "../cloudflare-relay/src/honcho.js";

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

/**
 * @param {{ dir?: string, entries?: object[], dryRun?: boolean, write?: boolean, env?: object, fetchImpl?: Function, ownUserId?: string, ownBotId?: string }} opts
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

  for (const row of entries) {
    if (row._bad) {
      bump(skipped, "bad-json");
      continue;
    }
    const decision = decideIngest(eventFromRow(row), {
      personalRe,
      ownUserId: opts.ownUserId || env.OWN_USER_ID,
      ownBotId: opts.ownBotId || env.OWN_BOT_ID,
    });
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
    const displayName = row.user_display_name || row.display_name || null;
    const prepared = await materialize(decision, { displayName });
    accepted.push(prepared);
    if (!dryRun) await sendIngest(env, prepared, { fetchImpl: opts.fetchImpl, state });
  }

  return { dryRun, accepted, skipped, wrote: dryRun ? 0 : accepted.length };
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
  const result = await backfillLogs({ dir, write, env: process.env });
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
