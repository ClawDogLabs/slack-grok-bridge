# slack-grok-bridge

Always-on Socket Mode bridge template: Slack events → POST to a Grok inbound webhook → your bot replies via Slack Web API.

**Two ways to receive Slack events.** Pick based on whether the host is awake 24/7:

| Host | Use | Why |
| --- | --- | --- |
| Always on and always awake (VPS, server, a desktop that never sleeps) | Socket Mode bridge (`index.js`, this folder) | Simple, no public URL needed |
| Sleeps or freezes when idle (for example a Grok Bot computer) | HTTP Events API through an always-on relay: [`cloudflare-relay/`](./cloudflare-relay/README.md) (Cloudflare Worker) or [`node-http-relay/`](./node-http-relay/README.md) (plain Node: Fly.io, Railway, Render, Cloud Run, any VPS) | Socket Mode can't hear anything while the host is frozen, and Slack doesn't replay those events |

Both send the same webhook payload, so the Grok routine is the same either way. See [Lessons learned](#lessons-learned-running-it-for-real).

**No Cloudflare?** You don't need it. See [`HOSTING.md`](./HOSTING.md) for the full decision tree: Socket Mode on any always-awake host, the same relay on Fly.io / Railway / Render / Cloud Run / a VPS via [`node-http-relay/`](./node-http-relay/README.md), adapters for Lambda / Cloud Functions / Azure Functions / Deno Deploy, the built-in Grok Bot Slack trigger, and when tunnels are (and aren't) OK.

**Does it work with Muse?** No. It targets Grok Bot's routine webhook (`Authorization: Bearer` inbound webhook). Meta's Muse agent has no documented equivalent wake webhook, and OpenAI's Dots isn't this shape either. Details in [`HOSTING.md`](./HOSTING.md#does-this-work-with-muse-or-other-agents).

**Target Slack workspace:** your own (tokens and webhook are always per-bot).

## Handoff for other Grok Bots

**Point your bot at this repo** — do not paste a long one-shot prompt.

One-liner:

```text
Follow https://github.com/ClawDogLabs/slack-grok-bridge SETUP-FOR-NEXT-BOT.md and set up my Slack bridge.
```

Full steps (clone path, Slack manifest YAML, **Grok inbound webhook** setup, secret-request, keep-alive, `reply_broadcast`): [`SETUP-FOR-NEXT-BOT.md`](./SETUP-FOR-NEXT-BOT.md).

## Clone path (each person)

Each person's Grok Bot clones **this** repo to their own path — **not** someone else's working tree:

```bash
cd /workspace
git clone git@github.com:ClawDogLabs/slack-grok-bridge.git slack-<theirbot>-bridge
# or: https://github.com/ClawDogLabs/slack-grok-bridge.git
cd /workspace/slack-<theirbot>-bridge
```

Example: bot display name `YourBot` → `/workspace/slack-yourbot-bridge`. Never reuse another person's `.env`, tokens, or `GROK_WEBHOOK_URL`.

## On Grok computer

```bash
cd /workspace/slack-<yourbot>-bridge
cp .env.example .env && chmod 600 .env
# Fill tokens via secret-request — never paste secrets in chat
# Required: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, GROK_WEBHOOK_URL
# Optional: SLACK_SIGNING_SECRET, GROK_WEBHOOK_SECRET
npm install
./start.sh          # refuses to start if required env vars are empty
```

## Slack app checklist (Socket Mode)

1. Socket Mode enabled
2. App-Level Token with `connections:write` → `SLACK_APP_TOKEN` (`xapp-...`)
3. Bot User OAuth Token → `SLACK_BOT_TOKEN` (`xoxb-...`)
4. Bot token scopes (typical): `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `channels:history` (as needed), `users:read`, `files:read`, `files:write`, `reactions:write`
5. Subscribe to bot events: `app_mention`, `message.im` (add channel events only if you want them)
6. Reinstall app to your workspace after scope changes
   - `reactions:write` is required for the acknowledgement emoji (`ACK_REACTION`, default `white_check_mark`). Without it the bridge logs the missing scope and still wakes the routine.
   - `files:read` lets the bridge or the routine call `files.info` and download attachments. `files:write` is required for [voice replies](voice/README.md). After adding a scope, reinstall the app to the workspace and refresh the bot token in `.env`, then restart the bridge.
7. Point `GROK_WEBHOOK_URL` at **this** agent's inbound webhook (not anyone else's)
8. `bot_user.display_name` must be **ASCII** and match To:/@picker (no accents)
9. Manifest fields (`name` / `description` / `long_description` / `background_color`) are **user-dependent** — confirm display name with the human first; `background_color` does **not** need to match anyone else's

Paste-ready manifest YAML lives in [`SETUP-FOR-NEXT-BOT.md`](./SETUP-FOR-NEXT-BOT.md).

## Grok inbound webhook (messenger / webhook trigger)

The bridge wakes your bot by POSTing to a **webhook-triggered routine** on that same Grok Bot.

1. Create a routine with trigger `{ "type": "webhook" }` (UpdateState / ask the bot to create one)
2. Copy **Webhook URL** + **sender key** from the routine panel — never paste the sender key in chat; use **secret-request** or write to `.env`
3. Set `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_SECRET` in `.env`
4. Bridge auth headers (when secret is set): `Authorization: Bearer …` and `X-Automation-Key`
5. Sidebar deep-links (folder = kebab-case routine name):  
   `[Webhook URL](grokbot://app/v1/sidebar?target=webhook-url&automation=<folder>)`  
   `[Sender key](grokbot://app/v1/sidebar?target=sender-key&automation=<folder>)`
6. Routine prompt should stay **quiet on health/probe** wakes with nothing to do

See [`SETUP-FOR-NEXT-BOT.md`](./SETUP-FOR-NEXT-BOT.md) for the full webhook recipe.

## Keep it running (no open terminal)

This box has no systemd. Use detached scripts + a Grok routine:

```bash
cd /workspace/slack-<yourbot>-bridge
./start.sh          # nohup supervise.sh + bridge.pid + bridge.log
./stop.sh           # stops supervisor + node (+ strays for this dir)
./ensure-running.sh # npm install if modules missing; start if the supervisor is down
```

How it fits together:

- `start.sh` launches `supervise.sh` detached. `bridge.pid` is the **supervisor**, `bridge.child.pid` is the current **node** process.
- `supervise.sh` restarts node whenever it exits, with backoff: 5 s, doubling to 60 s, and back to 5 s after a run longer than 5 minutes.
- `index.js` has a **connection watchdog**. Every 15 s it checks that the websocket is open and Slack has pinged it recently. After `WATCHDOG_MAX_UNHEALTHY_MS` (default 2 min) unhealthy it exits(1), and the supervisor starts a fresh connection. It also exits if `app.start()` hasn't finished in 90 s, and on any unhandled rejection.
- Socket Mode ping timeouts are relaxed from the library default: `CLIENT_PING_TIMEOUT_MS` (default 15000) and `SERVER_PING_TIMEOUT_MS` (default 60000).
- Socket state changes (`connecting`, `connected`, `reconnecting`, `disconnected`, …) and every `wake ok` / `wake FAILED` are logged with timestamps in `bridge.log`.

After [Update Grok Bot's Computer](grokbot://app/v1/settings?id=update-computer), `/workspace` and `.env` usually survive, but `node_modules` may need `npm install`. The ensure routine reinstalls when missing and starts the bridge.

**Socket Mode does not replay missed events.** After restart, smoke-test with an `@mention`. Prefer short keep-alive intervals (`ensure-running`). If the host sleeps when idle, keep-alives and watchdogs can't close the gap. Use an HTTP relay instead: [`cloudflare-relay/`](./cloudflare-relay/README.md) or [`node-http-relay/`](./node-http-relay/README.md) (see [`HOSTING.md`](./HOSTING.md)).

Do not leave `npm start` in a foreground desktop terminal; closing that session kills Socket Mode.

## Ack + thinking status

Bolt acks Socket Mode events when the listener Promise settles. This process:
1. Returns so Slack gets the ack within the 3s window
2. Reacts to the message with `ACK_REACTION` (default `white_check_mark`)
3. Shows a short `is thinking…` status, resolves the user, and POSTs the Grok webhook in the background
4. Clears the spinner as soon as the webhook is accepted

The reaction is the acknowledgement. It needs `reactions:write`. If that scope is missing, the bridge logs `reactions:write` and continues. If the configured emoji is not installed in the workspace, it logs that and retries with `white_check_mark`. Set `ACK_REACTION=off` to disable the reaction. Emoji names have no colons (`white_check_mark`, not `:white_check_mark:`).

The text hold-ack is **opt-in** (`HOLD_ACK=true`). Leave it off unless you also want a message. When it is on:
- Generic: "Got it - checking with the owner and will get back to you."
- Personal/family heuristic (kids, schedule, school, address, etc.): "That's not on my approved list of things to share publicly. Let me check with the owner and get back to you."

That text follows the [threading rule](#threading). `HOLD_ACK_BROADCAST` (default true) controls whether a **channel** hold-ack is also sent to the channel. DMs are never broadcast.

Other knobs: `THINKING_TIMEOUT_MS` (default 45000 safety clear), `BRIDGE_SOURCE` (payload `source` field). The HTTP relays use the same acknowledgement. A later `chat.postMessage` is the real answer and needs `chat:write`.

## Threading

Replies land in a different place in DMs than in channels. The Socket Mode bridge and both HTTP relays apply this to messages they post themselves, and they send the same decision on the webhook as `reply: { thread_ts, reply_broadcast }`. `thread_ts` is null when the reply should be top-level. The routine template follows `reply` when it posts.

- **DMs and group DMs:** a normal message. Set `thread_ts` only when the inbound message is already in a thread (`thread_ts` present and different from `ts`). Do not set `reply_broadcast`.
- **Channels:** reply in the thread (`thread_ts` is the parent, or the message `ts` if it started the thread) and set **`reply_broadcast: true`** so the channel sees it. That flag is per message, not a manifest setting.

`app_mention` often has no `channel_type`. The bridge calls `conversations.info` to tell a group DM from a channel. That needs the matching read scope (`channels:read`, `groups:read`, `im:read`, or `mpim:read`). If the lookup fails, the mention is treated as a channel.

File uploads cannot set `reply_broadcast`. Upload into the thread, then post a separate short message with `reply_broadcast` when the channel should see it. See [`voice/README.md`](voice/README.md).

Invite the bot into channels with `/invite @YourBotDisplayName`.

## Message log, history, and work status

Patterns for the routine, not extra bridge code:

- Log every relayed message, including file ids and mimetypes, to `log/raw/YYYY-MM-DD.jsonl`. Read recent channel or thread history before answering. An optional nightly routine writes `log/summaries/`, refreshes `log/index.md`, and deletes raw logs older than 30 days. [`docs/MESSAGE_LOG.md`](docs/MESSAGE_LOG.md).
- The main agent keeps `state/active-work.md` current. The Slack routine reads it before status answers so Slack matches the main chat. [`docs/WORK_STATUS.md`](docs/WORK_STATUS.md).
- Example wake-routine prompt (untrusted payload, allowlist, voice, handoff): [`docs/ROUTINE_PROMPT.example.md`](docs/ROUTINE_PROMPT.example.md).

`log/`, the live status file, and a live `REFERENCE_HISTORY.md` are gitignored.

## Honcho memory ingest (off by default)

Phase A writes public-channel Slack messages to [Honcho](https://honcho.dev) after the Slack ack. It does not read Honcho, and it does not run on the Grok wake path.

`HONCHO_INGEST` defaults off (`0` / unset / `false`). Set it to `1` only after the checklist in the relay README. `HONCHO_API_KEY` is a secret (wrangler secret or `.env`, never committed). `HONCHO_WORKSPACE_ID` defaults to `princeton-ai-slack`.

Scope is public channels (`channel_type` `channel`). DMs (`im`), group DMs (`mpim`), and private channels (`group`) are dropped. A channel id that starts with `C` is not enough: group DMs can use those ids too. When `channel_type` is missing, `HONCHO_CHANNEL_IDS` (comma-separated public channel ids) is the allowlist. Otherwise a working `conversations.info` lookup is used. If that call cannot classify (`missing_scope` until `channels:read` is granted), the row is skipped. The same personal-term hold as `looksPersonal()` / the owner share policy drops family, schedule, address, phone, and email text. Tokens, key URLs, street addresses, and financial account numbers are dropped too. Empty and bot-noise subtypes are skipped. The bot's own public-channel replies are kept. Log label `dinky` is stored under `OWN_USER_ID`, never as the peer id `dinky`.

Ordinary public messages do not wake Grok. The Worker schedules ingest with `ctx.waitUntil`. Socket Mode fires a void promise from `processInbound` and from the `message` listener. Neither awaits Honcho.

Backfill replays `log/raw/*.jsonl` without the Worker. Default is dry-run. Log rows usually have no `channel_type`, so name the public channels (the production token has no `channels:read`, so `conversations.info` fails closed):

```bash
node --env-file=.env scripts/honcho-backfill.mjs --dry-run --channel-ids C0123,C0456
node --env-file=.env scripts/honcho-backfill.mjs --write --channel-ids C0123,C0456
```

`HONCHO_CHANNEL_IDS` is the same list for the live bridge when an event has no `channel_type` (typical of `app_mention`). `--channel-ids` overrides it for one backfill run. Without a list and without a working `conversations.info`, those rows are skipped (`needs-channel-type`).

Slack will not deliver ordinary public messages until the app subscribes to the `message.channels` bot event. That is a manual step in the Slack app UI. This repo does not change Event Subscriptions. Mentions still arrive via `app_mention` without that subscription. The bot has to be in the channel.

## Voice replies

[`voice/`](voice/README.md) transcribes Slack audio locally (faster-whisper) and uploads a spoken reply (edge-tts, no API key). Configurable voice, rate, pitch, text file, comment, and a title taken from the clip topic. Needs `ffmpeg` on `PATH`, plus Slack `files:read` and `files:write`.

## Secrets

- Collect `xoxb` then `xapp` via **secret-request** only — never paste tokens in chat, never open them in vim/nano for the session log
- Never commit `.env`, `bridge.pid`, `bridge.child.pid`, `bridge.log`, or `node_modules` (see `.gitignore`)
- Relay: secrets live in Cloudflare (`wrangler secret put`). The real `wrangler.toml` is git-ignored. Commit only `wrangler.toml.example`
- Node relay: secrets live in your host's secret store (Fly secrets, Railway/Render variables, Cloud Run Secret Manager) or a git-ignored `.env`

## Owner share allowlist (Grok-managed)

Hold-ack is only UX. What the bot may **answer without asking again** is an **owner-specific allowlist** kept by that owner's Grok Bot.

### Principles

- **User-dependent.** Never copy another owner's list.
- **Default deny.** Anything not on the allowlist needs human approval before a substantive public reply.
- **Allowlist hit.** If the ask matches and the answer stays inside the listed bounds, the bot may reply and send without a new approval.
- **Expand only on explicit OK.** One-off "post that" does not auto-add; ask once whether to add the topic.

### Where it lives

1. Grok Bot durable memory (source of truth for decisions).
2. Optional `OWNER_SHARE_POLICY.md` beside the live bridge (keep in sync with memory).
3. Template: `OWNER_SHARE_POLICY.example.md` in this repo.

### How the owner manages it

Talk to the Grok Bot in chat:

| Say | Effect |
| --- | --- |
| `Add X to the share allowlist (bounds: …)` | Adds an allow entry |
| `Remove X` / `Don't share X anymore` | Removes it immediately |
| `You can answer Y without asking first` | Same as add |
| Approve a one-off reply | Bot asks once whether to add for next time |

After each change the bot should confirm the full short list.

### Bridge knobs (not the allowlist)

| Env | Role |
| --- | --- |
| `OWNER_DISPLAY_NAME` | Name used in hold-ack text (default `the owner`) |
| `ACK_REACTION` | Emoji added when a message arrives (default `white_check_mark`; `off` disables) |
| `HOLD_ACK` | Also post the text hold-ack (default off) |
| `HOLD_ACK_BROADCAST` | When the text hold-ack is on, also send it to the channel (default on) |

The allowlist itself is **not** an env secret; the agent owns it.

## Bot-to-bot mentions (ALLOW_BOT_IDS)

Slack delivers `app_mention` when another bot tags you, but **this bridge ignores bot authors by default** (avoids loops). To let another Grok bot wake you:

1. Get their Slack `bot_id` (`B…`) and/or bot user id (`U…`) via `users.info`.
2. Set in `.env`:
   - `ALLOW_BOT_IDS=B0XXXX,...`
   - and/or `ALLOW_BOT_USER_IDS=U0XXXX,...`
3. Restart the bridge (`./ensure-running.sh`).
4. Your own bot id is always dropped (self-loop guard).

Example: allow another bot with `ALLOW_BOT_IDS=B0XXXXXXX` and `ALLOW_BOT_USER_IDS=U0XXXXXXX` (get the real ids for that bot via `users.info`).
Each workspace/app maintains its **own** allowlist; ask the other owner to allow you back if you need two-way tags.

## Lessons learned (running it for real)

Notes from running this bridge on a Grok Bot computer in a real workspace.

**Socket Mode needs an always-on, always-awake host.** Socket Mode is a websocket the bridge keeps open. A Grok Bot computer is paused or frozen when idle, during the day for 5 to 20 minutes several times an hour, and overnight for hours. While it's frozen, nothing runs: not node, not the watchdog, not cron-style routines. The socket dies, `ping/pong` timeout warnings pile up when it thaws, and every event Slack sent in the meantime is lost, because **Slack does not replay Socket Mode events**. No watchdog or keep-alive *on the frozen host* can fix that. It can only shorten recovery after the host wakes.

**For hosts that sleep, use the HTTP Events API through an always-on relay.** [`cloudflare-relay/`](./cloudflare-relay/README.md) is a small Cloudflare Worker (free plan is fine) that Slack can always reach; [`node-http-relay/`](./node-http-relay/README.md) runs the same code as a plain Node server if you'd rather not use Cloudflare. It verifies Slack's signature and forwards each event to the Grok routine webhook, which wakes the bot. Turn on **Delayed Events** in Event Subscriptions too: if a delivery fails, Slack retries it for up to 24 hours instead of dropping it.

**Why not point Slack straight at the Grok routine webhook?** Two blockers:
1. Slack verifies a Request URL by sending a `url_verification` challenge and expecting it echoed back. The routine webhook only answers "received".
2. The routine webhook needs its secret in a request header (`Authorization` / `X-Automation-Key`), and Slack can't add custom headers.

A relay is the smallest thing that solves both.

**The default `clientPingTimeout` is too aggressive.** Bolt's Socket Mode default (5 s) treats any short stall of the host or an egress proxy as a dead connection and reconnects constantly. The bridge now uses 15 s client / 60 s server, adjustable through env.

**Reconnects can hang.** We saw the Socket Mode client stuck in "reconnecting" forever while the node process stayed alive. A keep-alive that only checks "is the pid alive?" reports healthy while the bot is deaf.

**Check connection health, not just process liveness.** That's what the watchdog in `index.js` is for: websocket open plus recent ping or message from Slack. Otherwise it exits, and `supervise.sh` restarts it.

**A green "online" dot in Slack means nothing here.** Bot users can show as permanently online. The dot stays green while the host is asleep and the socket is down. Check `bridge.log` (`socket-mode state: connected`), or the relay's `/health` and `wrangler tail`.

**Inviting users to private channels needs `groups:write`.** If the bot should run `conversations.invite` on private channels, add `groups:write` (and `channels:manage` for public ones), then reinstall the app.

**Host restarts can wipe `node_modules`.** `/workspace` and `.env` usually survive an update or restart of the Grok computer, but dependencies may not. `ensure-running.sh` reinstalls them before checking anything else.

**Keep-alive routines on a sleeping host are best-effort.** Scheduled runs that fall inside a frozen window run late or get skipped. Treat the keep-alive as recovery, not as coverage.

**Switching to the relay:** disable Socket Mode in the Slack app. While it's on, Slack keeps sending over the socket and never calls the Request URL. Also stop the bridge and its keep-alive, otherwise it crash-loops on `apps.connections.open`. Steps: [`cloudflare-relay/README.md`](./cloudflare-relay/README.md#switch-the-slack-app-to-http-delivery).
