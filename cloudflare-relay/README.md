# cloudflare-relay — Slack Events API → Grok webhook, for hosts that sleep

An always-on [Cloudflare Worker](https://developers.cloudflare.com/workers/) that receives Slack's
**HTTP Events API** deliveries and forwards them to your Grok Bot inbound (routine) webhook.

Use it instead of the Socket Mode bridge (`../index.js`) when the bridge's host is not awake 24/7,
for example a Grok Bot computer that freezes when idle. While the host is frozen the Socket Mode
connection is dead and Slack does **not** replay events sent in that window. The Worker is always
up, so Slack always has somewhere to deliver. The Grok routine is woken by the webhook and replies
with the bot token. See "Lessons learned" in the top-level README for the full story.

**No Cloudflare account?** [`../node-http-relay/`](../node-http-relay/README.md) runs this same module as a plain Node server (Fly.io, Railway, Render, Cloud Run, any VPS). See [`../HOSTING.md`](../HOSTING.md).

```
Slack ──HTTPS (signed)──▶ Worker (always on) ──POST + key──▶ Grok routine webhook ──▶ reply via bot token
```

## What it does

Same routing and headers as the bridge. The webhook body adds a `reply` object; a routine that ignores unknown fields needs no change. The text hold-ack is opt-in (`HOLD_ACK=true` keeps the old message). The default acknowledgement is a reaction.

- Verifies `X-Slack-Signature` (v0 HMAC-SHA256, 5-minute timestamp window). Unsigned or bad → `401`.
  No signing secret configured → `503` (fails closed).
- Answers Slack's `url_verification` handshake by echoing `challenge`.
- Acks every event within milliseconds; all slow work (user lookup, webhook, Slack posts) runs in
  `ctx.waitUntil`, so Slack's 3-second deadline is never at risk.
- `app_mention` (human, or a bot in `ALLOW_BOT_IDS` / `ALLOW_BOT_USER_IDS`) → reaction ack →
  thinking status → webhook `kind: "app_mention"`. On webhook failure it posts
  "Could not reach Grok webhook…" using the threading rule below.
- `message` in a DM (`im`) or group DM (`mpim`) → reaction ack → webhook `kind: "message"`.
  An explicit @mention in a group DM is handled once, via `app_mention`.
- The reaction emoji is `ACK_REACTION` (default `white_check_mark`). A missing custom emoji
  falls back to `white_check_mark`. A missing `reactions:write` scope is logged and the wake
  still happens. Set `ACK_REACTION` to `off` to disable. The text hold-ack is opt-in
  (`HOLD_ACK=true`) and follows the same placement as a real reply.
- **Threading.** DMs and group DMs get a plain reply unless the message is already in a
  thread. Channels get a thread reply with `reply_broadcast`. The webhook includes
  `reply: { thread_ts, reply_broadcast }` (`thread_ts` is null for a top-level DM).
  `app_mention` has no `channel_type`; the Worker calls `conversations.info` when it can
  (`channels:read`, `groups:read`, `im:read`, or `mpim:read`). If that call fails, the
  mention is treated as a channel.
- Bots (including itself), edits, deletes and other subtypes are ignored, except `file_share`
  (a user posting an image or PDF) and `slack_audio` (a voice clip). Both are forwarded
  with a `files` array when Slack includes one. A file whose mimetype starts with `audio/`,
  is `video/mp4`, or whose filetype is `m4a`, `mp3`, `webm`, `ogg`, `wav`, `mp4`, or `aac`
  counts as audio even when the subtype is missing.
- Every event response carries a debug header `X-Relay-Action: <action>:<reason>`.
- `GET /health` → `{"ok":true,"configured":true}` once the required secrets exist.

Webhook request (identical to the bridge):
`POST GROK_WEBHOOK_URL` with `Authorization: Bearer <GROK_WEBHOOK_SECRET>` and
`X-Automation-Key: <GROK_WEBHOOK_SECRET>`, body
`{ source, kind, slack: { type, user, user_name, user_real_name, user_display_name, channel, channel_type, ts, thread_ts, text, subtype, files }, hold_ack, reply }`.
`reply` is `{ thread_ts, reply_broadcast }`. `thread_ts` is null when the routine should post a top-level message.

### More config

| Var | Effect |
|-----|--------|
| `WATCH_CHANNEL_IDS` | Forward messages in these channels **without** an @mention, as `{ kind: "channel_message", watched: true, slack, reply }` (no thinking or hold-ack). A cheap pre-filter skips short chatter: forwarded only if it has `BOT_NAME`, a `?`, or more than 4 words. Audio skips that filter, including an empty caption (`watched-audio`). After a successful audio wake the Worker adds `ACK_REACTION` on that message. Other watched forwards do not react. Your routine must decide whether to answer. |
| `ACK_REACTION` | Emoji name without colons (default `white_check_mark`). `off` disables the reaction. A missing custom emoji falls back to `white_check_mark`. Missing `reactions:write` is logged. |
| `HOLD_ACK` | `"true"` also posts the text hold-ack. Default off, so a new deploy does not double-ack. |
| `HOLD_ACK_BROADCAST` | When the text hold-ack is on, also send it to the channel (default true). DMs are never broadcast. |
| `HOLD_ACK_SKIP_REGEX` | Asks matching this regex get no text hold-ack (e.g. off-topic questions your routine will politely decline). |
| `WELCOME_CHANNEL_IDS`, `WELCOME_TEXT`, `ASK_CHANNEL_ID` | New human joiners get a :wave: reaction and `WELCOME_TEXT` (`{user}`, `{ask_channel}` placeholders). Needs `reactions:write`. |
| `BOT_NAME`, `MPIM_REQUIRE_ADDRESS` | With `MPIM_REQUIRE_ADDRESS="true"`, group DMs only wake the bot when it's @mentioned, `BOT_NAME` appears, or the message is audio. |
| `RETRY_POLICY` | See below. |

`HOLD_ACK_DM_TOP_LEVEL` is no longer read. DM and group-DM placement follows the threading rule above. `ACK_REACTION` defaults on and `HOLD_ACK` defaults off. Watched-channel text forwards still do not react or post a hold-ack. A watched voice clip gets `ACK_REACTION` only after the webhook succeeds. The other rows stay off until you set them.

### Slack retries and Delayed Events

Slack retries a delivery when it doesn't get a fast 2xx (`X-Slack-Retry-Num` / `X-Slack-Retry-Reason`).
With **Delayed Events** enabled on the app, Slack keeps retrying failed deliveries for up to 24 hours.

- `drop_timeouts` (default): drop retries whose reason is `http_timeout`, because the first
  attempt reached the Worker and is already being handled (processing it again would wake Grok
  twice). Process other retries (`http_error`, `connection_failed`, …): the first attempt was never
  handled, so this is what lets Delayed Events recover messages.
- `drop_all`: never process retries. Simplest duplicate protection, but no recovery.
- `process_all`: process every retry (possible duplicate replies).

## Setup

Requirements: a Cloudflare account (the free plan is enough) and Node 18+. The pinned wrangler v3
works on Node 18/20. Wrangler v4 needs Node 20+ (or newer, check its release notes).

1. **API token.** Cloudflare dashboard → My Profile → API Tokens → Create Token → template
   **Edit Cloudflare Workers**. Scope *Account Resources* to the one account you'll deploy to and
   *Zone Resources* to "All zones from an account" for that account (or a specific zone). Export it
   in your shell, without pasting it into chat or committing it:
   ```bash
   export CLOUDFLARE_API_TOKEN=...      # keep out of shell history / repos
   export CLOUDFLARE_ACCOUNT_ID=...     # Workers & Pages overview → Account ID
   ```
2. **Configure.**
   ```bash
   cd cloudflare-relay
   npm install
   cp wrangler.toml.example wrangler.toml   # git-ignored; edit [vars]
   npm test                                 # offline tests (no network)
   ```
3. **Deploy** (first deploy creates `https://slack-bridge-example.<subdomain>.workers.dev`; if the
   account has no workers.dev subdomain yet, wrangler or the dashboard will ask you to pick one):
   ```bash
   npx wrangler deploy
   ```
4. **Secrets.** Pipe values in so they never land in history or logs. The values are the same as
   the bridge's `.env`:
   ```bash
   printf '%s' "$SLACK_BOT_TOKEN"      | npx wrangler secret put SLACK_BOT_TOKEN
   printf '%s' "$GROK_WEBHOOK_URL"     | npx wrangler secret put GROK_WEBHOOK_URL
   printf '%s' "$GROK_WEBHOOK_SECRET"  | npx wrangler secret put GROK_WEBHOOK_SECRET
   printf '%s' "$SLACK_SIGNING_SECRET" | npx wrangler secret put SLACK_SIGNING_SECRET
   # Only after you intend to ingest. Leave HONCHO_INGEST = "0" until then.
   # printf '%s' "$HONCHO_API_KEY"    | npx wrangler secret put HONCHO_API_KEY
   ```
   The signing secret is under api.slack.com → your app → **Basic Information → App Credentials →
   Signing Secret**. The bot token needs `reactions:write` for the ack emoji, and `files:write`
   as well if the routine uploads voice replies. Reinstall the Slack app after adding scopes.
   Check `curl https://<worker-url>/health` shows `"configured":true` **before**
   switching Slack over.
5. **Smoke-test without Slack.** An unsigned POST must get `401`:
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<worker-url>/slack/events -d '{}'`

## Switch the Slack app to HTTP delivery

In [api.slack.com/apps](https://api.slack.com/apps) → your app:

1. **Event Subscriptions → Subscribe to bot events:** write down the current list and keep it the
   same (typically `app_mention`, `message.im`, `message.mpim`, plus `message.channels` /
   `message.groups` if you use `WATCH_CHANNEL_IDS` / `WELCOME_CHANNEL_IDS`).
2. **Socket Mode →** turn **Enable Socket Mode** off. While Socket Mode is on, Slack keeps delivering
   over the socket and never calls the Request URL.
3. **Event Subscriptions →** Enable Events on → **Request URL**
   `https://<worker-url>/slack/events` → wait for **Verified** → turn on **Delayed Events** →
   **Save Changes**. Reinstall the app only if Slack shows a banner asking you to.
4. Stop the Socket Mode bridge (`../stop.sh`) and change any keep-alive routine so it no longer
   runs `ensure-running.sh`. With Socket Mode off, the bridge would crash-loop on
   `apps.connections.open`.
5. Test: DM the bot, and @mention it in a channel it's in, while watching
   `npx wrangler tail slack-bridge-example`.

## Honcho ingest (off by default)

`HONCHO_INGEST` in `[vars]` defaults to `"0"`. Public-channel writes run inside `ctx.waitUntil` after the Worker has already built the `200` response. `wakeGrok` does not call Honcho. Ingest itself does not read.

### Optional wake-path reads (off by default)

`HONCHO_READ` is independent of `HONCHO_INGEST` and defaults to `"0"`. When it is `"1"`, `processInbound` and `forwardWatched` GET the per-channel session (`channel-<id>`) and attach the result as `payload.honcho` before `wakeGrok`. `HONCHO_READ_TIMEOUT_MS` defaults to `1500` and is capped at `15000`. A missing key, HTTP error, or timeout still wakes Grok with `honcho.ok === false`. The read runs in `ctx.waitUntil`, so the Slack `200` is not delayed. Socket Mode stays write-only; this read hook is on the Worker module, which `node-http-relay` imports.

`HONCHO_API_KEY` is required for ingest and for reads. Set it with `npx wrangler secret put`, not in `wrangler.toml`.

`HONCHO_CHANNEL_IDS` is optional. Set it to comma-separated public channel ids. The current bot token gets `missing_scope` from `conversations.info` (no `channels:read`). Events that already include `channel_type: channel` still ingest. `app_mention` often has no type: those are ingested only when the channel id is in `HONCHO_CHANNEL_IDS`, or when `conversations.info` succeeds and says the channel is public. A failed lookup does not treat a `C` id as public, so a group-DM mention is not written. Wake routing is unchanged.

1. Keep `HONCHO_INGEST` at `"0"` and deploy.
2. In Slack, **Event Subscriptions → Subscribe to bot events**, add `message.channels` if it is not already there. Save. Reinstall only if Slack asks. Do not add `message.groups` for this phase (private channels are filtered out). The bot must already be in the channel. `channels:history` is the matching scope (already on the sample manifest).
3. Dry-run history from the repo root. Pass the public channel ids, because log rows have no `channel_type` and `conversations.info` fails closed without `channels:read`:
   `node --env-file=.env scripts/honcho-backfill.mjs --dry-run --channel-ids C0123,C0456`
   `--write` posts. The script does not use the Worker. `samplebot` in the log is written as `OWN_USER_ID` (or `auth.test` `user_id`), not the string `samplebot`.
4. `npx wrangler secret put HONCHO_API_KEY`, confirm `HONCHO_WORKSPACE_ID` (`slack-workspace` if unset), then set `HONCHO_INGEST = "1"` and deploy again.
5. Watch `npx wrangler tail` for `honcho ok` / `honcho skip`. A DM must not produce a Honcho post.
6. Rollback: set `HONCHO_INGEST` back to `"0"` (or delete the var) and deploy. Ingest becomes a no-op. Already stored Honcho messages are left as-is.

## Redeploy / rollback

```bash
npx wrangler deploy                  # redeploy after edits
npx wrangler deployments list        # history
npx wrangler rollback [<version-id>] # previous or specific version
npx wrangler tail slack-bridge-example   # live logs
```

- **Emergency stop without touching Slack:** `npx wrangler secret delete SLACK_SIGNING_SECRET`.
  Every request then gets `503`, and with Delayed Events Slack keeps retrying for up to 24 h, so
  restoring the secret recovers those messages.
- **Back to Socket Mode:** turn Socket Mode on in the Slack app, then `../start.sh` on the host.
