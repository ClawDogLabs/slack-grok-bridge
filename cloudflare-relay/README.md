# cloudflare-relay — Slack Events API → Grok webhook, for hosts that sleep

An always-on [Cloudflare Worker](https://developers.cloudflare.com/workers/) that receives Slack's
**HTTP Events API** deliveries and forwards them to your Grok Bot inbound (routine) webhook.

Use it instead of the Socket Mode bridge (`../index.js`) when the bridge's host is not awake 24/7,
for example a Grok Bot computer that freezes when idle. While the host is frozen the Socket Mode
connection is dead and Slack does **not** replay events sent in that window. The Worker is always
up, so Slack always has somewhere to deliver. The Grok routine is woken by the webhook and replies
with the bot token. See "Lessons learned" in the top-level README for the full story.

```
Slack ──HTTPS (signed)──▶ Worker (always on) ──POST + key──▶ Grok routine webhook ──▶ reply via bot token
```

## What it does

Same routing, payload and headers as the bridge, so **an existing wake routine needs no change**.

- Verifies `X-Slack-Signature` (v0 HMAC-SHA256, 5-minute timestamp window). Unsigned or bad → `401`.
  No signing secret configured → `503` (fails closed).
- Answers Slack's `url_verification` handshake by echoing `challenge`.
- Acks every event within milliseconds; all slow work (user lookup, webhook, Slack posts) runs in
  `ctx.waitUntil`, so Slack's 3-second deadline is never at risk.
- `app_mention` (human, or a bot in `ALLOW_BOT_IDS` / `ALLOW_BOT_USER_IDS`) → thinking status →
  webhook `kind: "app_mention"` → hold-ack in thread. On webhook failure it posts
  "Could not reach Grok webhook…" in the thread.
- `message` in a DM (`im`) or group DM (`mpim`) → webhook `kind: "message"` + hold-ack.
  An explicit @mention in a group DM is handled once, via `app_mention`.
- Bots (including itself), edits, deletes and other subtypes are ignored, except `file_share`
  (a user posting an image or PDF), which is forwarded with a `files` array.
- Every event response carries a debug header `X-Relay-Action: <action>:<reason>`.
- `GET /health` → `{"ok":true,"configured":true}` once the required secrets exist.

Webhook request (identical to the bridge):
`POST GROK_WEBHOOK_URL` with `Authorization: Bearer <GROK_WEBHOOK_SECRET>` and
`X-Automation-Key: <GROK_WEBHOOK_SECRET>`, body
`{ source, kind, slack: { type, user, user_name, user_real_name, user_display_name, channel, channel_type, ts, thread_ts, text, subtype, files }, hold_ack }`.

### Optional extras (off by default)

| Var | Effect |
|-----|--------|
| `WATCH_CHANNEL_IDS` | Forward messages in these channels **without** an @mention, as `{ kind: "channel_message", watched: true, slack }` (no thinking / hold-ack). A cheap pre-filter skips short chatter: forwarded only if it has `BOT_NAME`, a `?`, or more than 4 words. Your routine must decide whether to answer. |
| `WELCOME_CHANNEL_IDS`, `WELCOME_TEXT`, `ASK_CHANNEL_ID` | New human joiners get a :wave: reaction and `WELCOME_TEXT` (`{user}`, `{ask_channel}` placeholders). Needs `reactions:write`. |
| `BOT_NAME`, `MPIM_REQUIRE_ADDRESS` | With `MPIM_REQUIRE_ADDRESS="true"`, group DMs only wake the bot when it's @mentioned or `BOT_NAME` appears. |
| `HOLD_ACK_DM_TOP_LEVEL` | `"true"` posts the DM hold-ack as a normal message instead of a thread reply. |
| `HOLD_ACK_SKIP_REGEX` | Asks matching this regex get no hold-ack (e.g. off-topic questions your routine will politely decline). |
| `RETRY_POLICY` | See below. |

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
3. **Deploy** (first deploy creates `https://slack-grok-relay.<subdomain>.workers.dev`; if the
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
   ```
   The signing secret is under api.slack.com → your app → **Basic Information → App Credentials →
   Signing Secret**. Check `curl https://<worker-url>/health` shows `"configured":true` **before**
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
   `npx wrangler tail slack-grok-relay`.

## Redeploy / rollback

```bash
npx wrangler deploy                  # redeploy after edits
npx wrangler deployments list        # history
npx wrangler rollback [<version-id>] # previous or specific version
npx wrangler tail slack-grok-relay   # live logs
```

- **Emergency stop without touching Slack:** `npx wrangler secret delete SLACK_SIGNING_SECRET`.
  Every request then gets `503`, and with Delayed Events Slack keeps retrying for up to 24 h, so
  restoring the secret recovers those messages.
- **Back to Socket Mode:** turn Socket Mode on in the Slack app, then `../start.sh` on the host.
