# SETUP-FOR-NEXT-BOT — ClawDogLabs Slack ↔ Grok Bot bridge

Handoff for anyone joining the **ClawDogLabs** Slack workspace. Paste or forward this to your own Grok Bot so it can stand up **its own** Slack app + Socket Mode bridge.

**Workspace:** ClawDogLabs  
**Template repo:** [ClawDogLabs/slack-grok-bridge](https://github.com/ClawDogLabs/slack-grok-bridge)  
**Clone path on your box:** `/workspace/slack-<yourbot>-bridge`  
**Do not** clone into or reuse another person's working tree (e.g. someone else's `/workspace/slack-*-bridge`).  
**Do not reuse anyone else's tokens or webhook.** Each person gets their own Slack app (`xoxb` / `xapp`) and their own Grok inbound webhook.

No secrets belong in this doc or in chat.

---

## What is already done (workspace)

1. A **Slack workspace: ClawDogLabs** exists for this group.
2. Each person creates **their own** Slack app via **Create New App → From a manifest** (not “From scratch” Starter, and not the AI Agent template).
3. Manifest YAML includes:
   - `display_information` — `name`, `description`, `long_description`, `background_color`
   - `features.bot_user.display_name` — **ASCII only** (Slack rejects accents)
   - Bot OAuth scopes (see manifest below)
   - `settings.socket_mode_enabled: true`
   - Bot events: `app_mention`, `message.im`
4. Generate an **App-Level Token** with scope `connections:write` → `xapp-…` (`SLACK_APP_TOKEN`).
5. Install the app to ClawDogLabs and copy the **Bot User OAuth Token** → `xoxb-…` (`SLACK_BOT_TOKEN`).
6. Confirm **`bot_user.display_name` matches what Slack shows in To: / @picker**. App *name* alone is not enough — people invite and mention the **bot display name**.

Invite bots into channels with `/invite @BotDisplayName`.

---

## Manifest is user-dependent

**Before creating the app**, the Grok Bot must **confirm the display name with the human**, then fill:

- `display_information.name`
- `display_information.description`
- `display_information.long_description`
- `display_information.background_color` — **does not need to match anyone else's**
- `features.bot_user.display_name` — **ASCII only** (no accents)

Do not copy another bot's branding blindly.

### Manifest (paste-ready YAML)

Replace `YOUR_BOT_NAME` (and the display strings / color) after confirming with the human. Create the app with **From a manifest**, then install to **ClawDogLabs**.

```yaml
display_information:
  name: YOUR_BOT_NAME
  description: Grok Bot bridge for ClawDogLabs
  long_description: Socket Mode Slack bridge that wakes this person's Grok Bot on @mentions and DMs, then posts replies back into threads.
  background_color: "#1a1a2e"
features:
  bot_user:
    display_name: YOUR_BOT_NAME
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - channels:history
      - groups:history
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

After create:

1. **Basic Information → App-Level Tokens** → Generate token with `connections:write` → `xapp-…`
2. **OAuth & Permissions → Install to Workspace** (ClawDogLabs) → Bot User OAuth Token `xoxb-…`
3. Confirm Socket Mode is on and Event Subscriptions list `app_mention` + `message.im` (manifest usually sets this).
4. Reinstall if you change scopes later.

---

## What each person's Grok Bot does (on THEIR computer / box)

### 1. Clone THIS template (not someone else's tree)

```bash
cd /workspace
git clone https://github.com/ClawDogLabs/slack-grok-bridge.git slack-<yourbot>-bridge
cd /workspace/slack-<yourbot>-bridge
# Do NOT copy another person's /workspace/slack-*-bridge or their .env
cp .env.example .env
chmod 600 .env
```

Optional: set webhook payload `source` in `index.js` to identify your bridge (default is `slack-grok-bridge`).

Core behavior:

- Bolt `socketMode: true` with `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`
- Listen `app_mention` + DM/MPIM `message`
- Ack fast (thinking status optional); POST webhook in background

### 2. Collect secrets — secret-request only (never chat / never vim)

**NEVER** ask the human to paste tokens in chat, and do **not** open `.env` in vim/nano in a way that dumps secrets into the session.

Use Grok Bot **secret-request** (secure form) **twice**:

1. Bot User OAuth Token (`xoxb-…`) → write `SLACK_BOT_TOKEN=…` into `.env` from `process.env` (or the secret-request result) **without echoing values**
2. App-Level Token (`xapp-…`) → write `SLACK_APP_TOKEN=…` the same way

Then:

```bash
chmod 600 .env
# Verify keys exist without printing values:
awk -F= '{print $1}' .env
```

### 3. Wire THIS bot’s own Grok inbound webhook

Point env at **that** Grok Bot’s messenger / inbound webhook — **not anyone else's**:

- `GROK_WEBHOOK_URL` — that agent’s webhook URL
- `GROK_WEBHOOK_SECRET` — if the webhook requires a sender key (bridge sends `Authorization: Bearer …` and `X-Automation-Key`)

If no webhook exists yet: create an inbound webhook / messenger routine in Grok Bot settings, then copy **URL** and **secret** from the routine panel fields into `.env` via secret-request (or write from env without echoing). Link the human to the routine panel so they can confirm the fields.

### 4. Install + start + verify

```bash
cd /workspace/slack-<yourbot>-bridge
npm install
./start.sh
# Log should show Socket Mode up, e.g.:
# ⚡️ slack-grok-bridge running (Socket Mode; …)
tail -n 30 bridge.log
```

`./start.sh` refuses to start if required env keys are empty. Do **not** leave `npm start` in a foreground desktop terminal — closing that session kills Socket Mode. Use `start.sh` (nohup + `bridge.pid` + `bridge.log`).

### 5. Keep-alive routine

This box has no systemd. Create a Grok routine that runs weekday daytime:

```bash
cd /workspace/slack-<yourbot>-bridge && ./ensure-running.sh
```

Use a cron-like schedule (e.g. **`:21` / `:51`** past the hour, or similar twice-hourly daytime weekday slots). `ensure-running.sh` is quiet/idempotent if already up; it `npm install`s if `node_modules` is missing, then starts.

### 6. After Update Grok Bot’s Computer / reboot

1. `./ensure-running.sh`
2. If `node_modules` was wiped, ensure-running / `npm install` restores it; `/workspace` and `.env` usually survive
3. Check `bridge.log` for Socket Mode running
4. **Catch-up:** Socket Mode does **not** replay events missed while the bridge was down. This template has **no** backlog scanner. Document that gap; recommend short keep-alive intervals + a **manual smoke-test `@mention` after restart** so someone exercises the path. Optional future work: scan recent mentions/DMs via Web API if you implement catch-up — until then, smoke-test only.

### 7. Outbound replies

- **Human ack before send** unless the owner has granted standing permission for that channel/use.
- Post with Slack Web API `chat.postMessage`:
  - `channel` — from the inbound event
  - `thread_ts` — inbound `thread_ts` or parent `ts`
  - For **channel-visible** thread replies (Slack UI “Also send to #channel”), set **`reply_broadcast: true`**
- **`reply_broadcast` is a per-message flag on `chat.postMessage`, not a YAML/manifest setting.**
- Without `reply_broadcast`, thread replies stay in-thread only.

Example shape (no real tokens):

```js
await client.chat.postMessage({
  channel,
  thread_ts: threadTs,
  text: replyText,
  reply_broadcast: true, // Also send to #channel
});
```

### 8. Channel access

Someone with channel access runs:

```text
/invite @YOUR_BOT_NAME
```

DMs work after the human messages the bot (or opens a DM). Mentions in channels require the invite.

---

## Checklist (short)

| Step | Done when |
|------|-----------|
| Clone THIS repo to `/workspace/slack-<yourbot>-bridge` | Clean tree; no one else's `.env` |
| Slack app from manifest on ClawDogLabs | App installed; ASCII `bot_user.display_name` matches @picker; color/descriptions are yours |
| `xoxb` then `xapp` via secret-request | In `.env` mode 600; keys present; values never in chat / vim |
| Own `GROK_WEBHOOK_URL` (+ secret) | Points at **this** bot’s inbound webhook |
| `npm install` + `./start.sh` | `bridge.log` shows Socket Mode running |
| Keep-alive routine | Weekday daytime `ensure-running` (~`:21`/`:51`) |
| Invite + smoke `@mention` | Bot wakes; reply uses `thread_ts` (+ `reply_broadcast` if desired) |
| Reboot recovery | ensure-running + smoke `@mention`; no missed-event replay |

---

## Prompt for your Grok Bot

Copy everything below the line to your Grok Bot:

---

Set up my Slack bridge on **ClawDogLabs**, following the **ClawDogLabs/slack-grok-bridge** template. Clone **this** repo to `/workspace/slack-<mybot>-bridge`. Do **not** use anyone else's bridge directory or `.env`. Do **not** print or ask me to paste tokens in chat.

**Slack app (I will click; you guide):**

1. Create app via **From a manifest** (not Starter / AI agent).
2. **Confirm my ASCII bot display name with me first**, then fill `name` / `description` / `long_description` / `background_color` yourself (`background_color` does not need to match anyone else's). `bot_user.display_name` must be ASCII (no accents) and match To:/@picker:

```yaml
display_information:
  name: YOUR_BOT_NAME
  description: Grok Bot bridge for ClawDogLabs
  long_description: Socket Mode Slack bridge that wakes this Grok Bot on @mentions and DMs, then posts replies into threads.
  background_color: "#1a1a2e"
features:
  bot_user:
    display_name: YOUR_BOT_NAME
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - channels:history
      - groups:history
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

3. Generate App-Level Token `connections:write` (`xapp`). Install to ClawDogLabs; copy Bot OAuth Token (`xoxb`).

**On my Grok computer:**

1. `git clone` ClawDogLabs/slack-grok-bridge → `/workspace/slack-<mybot>-bridge`. `cp .env.example .env` && `chmod 600 .env`. Never copy another person's tree or secrets.
2. Collect secrets with **secret-request** twice — first Bot token `xoxb`, then App token `xapp`. Write into `.env` from the secure result / `process.env` **without echoing values**. Never use vim for tokens; never ask me to paste tokens in chat.
3. Point `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_SECRET` at **my** inbound webhook / messenger routine (not anyone else's). Create the webhook routine if needed; tell me which routine panel fields to use.
4. `npm install` && `./start.sh`. Verify `bridge.log` shows Socket Mode running.
5. Create a keep-alive routine: weekday daytime `./ensure-running.sh` on a `:21`/`:51` (or similar) schedule; quiet if already up.
6. After Update Grok Bot’s Computer / reboot: run `ensure-running`; `npm install` if `node_modules` missing; check `bridge.log`. Socket Mode does **not** replay missed events — no catch-up in this template; after restart have someone send a test `@mention`. Recommend short keep-alive.
7. Outbound replies: **human ack before send** unless I grant standing permission. Use `chat.postMessage` with `channel` + `thread_ts`. For channel visibility (Slack “Also send to #channel”), set `reply_broadcast: true` on that message (per-message API flag, not YAML).
8. Remind the workspace to `/invite @MyBotName` into channels.

Report paths written and verification (log line). Never print token values.

---

## Related

- Template README: [README.md](./README.md)
- Repo: https://github.com/ClawDogLabs/slack-grok-bridge
