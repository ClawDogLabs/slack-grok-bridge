# slack-grok-bridge

Always-on Socket Mode bridge template: Slack events → POST to a Grok inbound webhook → your bot replies via Slack Web API.

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
4. Bot token scopes (typical): `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `channels:history` (as needed), `users:read`, `files:read`
5. Subscribe to bot events: `app_mention`, `message.im` (add channel events only if you want them)
6. Reinstall app to your workspace after scope changes
   - `files:read` is required so the bridge (or messenger) can call `files.info` / download attached images when someone says "send me this screenshot". After adding the scope, reinstall the app to the workspace and refresh the bot token (`xoxb-…`) in `.env`, then restart the bridge.
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
./start.sh          # nohup + bridge.pid + bridge.log
./stop.sh
./ensure-running.sh # start if down; npm install if modules missing
```

After [Update Grok Bot's Computer](grokbot://app/v1/settings?id=update-computer), `/workspace` and `.env` usually survive, but `node_modules` may need `npm install`. The ensure routine reinstalls when missing and starts the bridge.

**Socket Mode does not replay missed events.** After restart, smoke-test with an `@mention`. Prefer short keep-alive intervals (`ensure-running`).

Do not leave `npm start` in a foreground desktop terminal; closing that session kills Socket Mode.

## Ack + thinking status

Bolt acks Socket Mode events when the listener Promise settles. This process:
1. Shows a short `is thinking…` status
2. Returns so Slack gets the ack within the 3s window
3. Resolves the user + POSTs the Grok webhook in the background
4. Clears the spinner as soon as the webhook is accepted
5. Posts an instant threaded **hold-ack** so the room knows the bot heard them while the owner reviews

Hold-ack text:
- Generic: "Got it - checking with the owner and will get back to you."
- Personal/family heuristic (kids, schedule, school, address, etc.): "That's not on my approved list of things to share publicly. Let me check with the owner and get back to you."

Env knobs: `HOLD_ACK` (default true), `HOLD_ACK_BROADCAST` (default true; Also send to channel), `THINKING_TIMEOUT_MS` (default 45000 safety clear), `BRIDGE_SOURCE` (payload `source` field).

A later approved `chat.postMessage` is the real answer. Needs `chat:write`.

## Outbound replies

Human ack before send unless standing permission. Use `chat.postMessage` with `channel` + `thread_ts`. For channel-visible thread replies (Slack UI “Also send to #channel”), set **`reply_broadcast: true`** on that message — it is a **per-message** API flag, not a YAML/manifest setting.

Invite the bot into channels with `/invite @YourBotDisplayName`.

## Secrets

- Collect `xoxb` then `xapp` via **secret-request** only — never paste tokens in chat, never open them in vim/nano for the session log
- Never commit `.env`, `bridge.pid`, `bridge.log`, or `node_modules` (see `.gitignore`)

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
| `HOLD_ACK` | Instant threaded ack after webhook (default on) |
| `HOLD_ACK_BROADCAST` | Also send hold-ack to channel (default on) |

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

