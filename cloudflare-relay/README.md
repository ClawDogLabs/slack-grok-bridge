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
  An allow-listed bot is ignored once it has posted more than `BOT_REPLY_CAP` messages
  in that thread (default 3), so two bots cannot reply to each other forever.
  Humans are never capped, and a top-level bot message is always allowed.
  If the thread cannot be read, the bot mention is ignored.
- `message` in a DM (`im`) or group DM (`mpim`) → reaction ack → webhook `kind: "message"`.
  An explicit @mention in a group DM is handled once, via `app_mention`.
- The reaction emoji is `ACK_REACTION` (default `white_check_mark`). A missing custom emoji
  falls back to `white_check_mark`. A missing `reactions:write` scope is logged and the wake
  still happens. Set `ACK_REACTION` to `off` to disable. The text hold-ack is opt-in
  (`HOLD_ACK=true`) and follows the same placement as a real reply.
- **Threading hint.** Messages this Worker posts use that placement, and the webhook
  copies it to `reply: { thread_ts, reply_broadcast }`. For a top-level 1:1 the hint is
  still `thread_ts: null` and `reply_broadcast: false`. Group DMs stay top-level unless
  the message is already in a thread. Channel events get `reply_broadcast: true` on the
  hint, including follow-ups. The routine broadcasts only the first answer to a human
  ask that @mentions exactly one bot; multi-bot asks and follow-ups stay in the thread.
  A `kind: "privroom_synthesize"` reply may still broadcast. The answer path is
  `routing`, not that hint. A top-level 1:1 is `routing.surface` `im` with
  `reply_thread_ts` null. An existing DM thread is `im_thread`. `assistant_thread`
  is only a thread Slack named. See the top-level README. `app_mention` has no
  `channel_type`; the Worker calls `conversations.info`
  when it can (`channels:read`, `groups:read`, `im:read`, or `mpim:read`). If that call
  fails, the mention is treated as a channel.
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
`{ source, kind, slack, hold_ack, reply, routing }`.
`reply` is the relay's own placement hint. `routing` is `{ surface, panel, provenance, reply_thread_ts, reply_broadcast, context, viewed, viewed_source }`. Post the answer from `routing`. On a channel, `reply.reply_broadcast` can still be true for a follow-up; `routing.reply_broadcast` is true only for the first single-bot answer. A private-room synthesis wake is separate and may still broadcast.

## Tag-only follow-ups

People sometimes post a question, then a few seconds later post a second message that only @mentions the bot. That second message has nothing to answer. When `processInbound` handles a mention whose text is only mentions and whitespace, and the mention tags this bot, the Worker looks up the newest message just before it in the same conversation. A top-level mention uses `conversations.history`. A mention inside a thread (`thread_ts` different from `ts`) uses `conversations.replies`. `node-http-relay` imports this module, so it does the same lookup. Socket Mode does not.

The prior message is merged only when all of these are true:

- It is from the same human user (not a bot message, and not `app_id` with no user).
- It is within `PRIOR_WINDOW_SECONDS` (60 seconds). Older messages stay out.
- Its subtype is absent, or is `file_share` or `thread_broadcast`. Other subtypes are ignored.
- It has real text, not another mention-only line.
- It is in the same thread scope: the thread parent or a reply in that thread when the mention is in a thread; otherwise a top-level message, or a `thread_broadcast`.

On a merge the wake payload adds `slack.original_text` (the raw mention), `slack.prior_text`, and `slack.prior_ts`. `slack.text` becomes `[prior message from same user]: <prior>` plus a newline plus the mention text trimmed. `slack.ts` stays the mention timestamp, so replies still thread under the mention. Later steps in that wake, including the hold-ack personal check and an optional Honcho read, see the merged text.

A mention that already has text does no lookup at all. The lookup is read-only and fail-open: any Slack API error, missing scope, or exception keeps the original text and the original wake. The history scopes are `channels:history`, `groups:history`, `im:history`, and `mpim:history`. Without the scope for that conversation the Worker logs `tag-only prior lookup skipped` and behaves as before. The sample manifest already includes the first three. Group DMs need `mpim:history`, which the manifest does not include; add it and reinstall only if tag-only follow-ups in group DMs should merge.

### More config

| Var | Effect |
|-----|--------|
| `WATCH_CHANNEL_IDS` | Forward messages in these channels **without** an @mention, as `{ kind: "channel_message", watched: true, slack, reply }` (no thinking or hold-ack). A cheap pre-filter skips short chatter: forwarded only if it has `BOT_NAME`, a `?`, or more than 4 words. Audio skips that filter, including an empty caption (`watched-audio`). After a successful audio wake the Worker adds `ACK_REACTION` on that message. Other watched forwards do not react. Your routine must decide whether to answer. |
| `ACK_REACTION` | Emoji name without colons (default `white_check_mark`). `off` disables the reaction. A missing custom emoji falls back to `white_check_mark`. Missing `reactions:write` is logged. |
| `HOLD_ACK` | `"true"` also posts the text hold-ack. Default off, so a new deploy does not double-ack. |
| `HOLD_ACK_BROADCAST` | When the text hold-ack is on, also send it to the channel (default true). The Worker does not set `reply_broadcast` on a DM hold-ack. |
| `HOLD_ACK_SKIP_REGEX` | Asks matching this regex get no text hold-ack (e.g. off-topic questions your routine will politely decline). |
| `WELCOME_CHANNEL_IDS`, `WELCOME_TEXT`, `ASK_CHANNEL_ID` | New human joiners get a :wave: reaction and `WELCOME_TEXT` (`{user}`, `{ask_channel}` placeholders). Needs `reactions:write`. |
| `ALLOW_BOT_IDS`, `ALLOW_BOT_USER_IDS` | Other bots allowed to @mention this bot (`B…` and/or bot user `U…`, comma-separated). Empty ignores every bot mention. This bot's own id is always ignored. |
| `BOT_REPLY_CAP` | After an allow-listed bot has posted more than this many messages in a thread (default `3`), later @mentions from that bot in the thread are ignored. Humans are never capped. A top-level bot message (no `thread_ts`) is always allowed. The count is that bot's messages in `conversations.replies` (limit 200). If the call fails or the thread cannot be read, the relay ignores the bot mention (fail closed). `conversations.replies` needs a history scope for the conversation type. The manifest already includes `channels:history`, `groups:history`, and `im:history`, so public channels, private channels, and DMs need no new scope. Group DMs need `mpim:history`, which is not in the manifest; without it the relay fails closed for bot mentions in group-DM threads. Add that scope and reinstall only if the cap should count messages there. |
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

## Mute a channel (no recording)

`SILENT_CHANNEL_IDS` is a comma-separated list of Slack channel ids. For every event in those channels the Worker returns HTTP 200 and stops. It does not call `reactions.add` (so a custom ack such as `sample-ack` is not added), `assistant.threads.setStatus`, `chat.postMessage`, `conversations.replies`, or the Grok webhook, and it does not write Honcho. The check is in front of `auth.test`, routing, welcome, watched-channel wakes, and ingest. It covers `app_mention` (including messages with an `edited` field), `message`, `message_changed` (channel on the outer event or on `message.channel`), thread replies, `channel_join` / `group_join`, `member_joined_channel`, and Slack retries.

Listing a channel does **not** turn on recording. Leave `HONCHO_INGEST` as it is. Do **not** add the muted id to `HONCHO_CHANNEL_IDS` (that list is the public-ingest allowlist and would store messages on the shared Slack user peer). Backfill skips muted ids the same way.

`message.groups` and `groups:history` are **not** required for this mute. Mentions in a private channel already arrive as `app_mention`, which is the path that was adding the ack and the thinking status. Those subscription and scope checks matter only before a later recording enablement. Recording stays off until that privacy path is reviewed and explicitly switched on. This change does not add that switch.

Deploy the mute (do this only when you intend to ship; this repo does not deploy it):

1. Deploy **this** revision of the Worker before relying on the variable. An older Worker ignores `SILENT_CHANNEL_IDS` and will keep acking.
2. Set `SILENT_CHANNEL_IDS = "C0SYNTH0001"` in `[vars]` and deploy again. One deploy of this revision with the variable already set is enough.
3. Do not post test messages into the channel. Watch `npx wrangler tail slack-bridge-example` for a `silent` log line and confirm there is no `wake ok` for that channel.
4. Rollback the mute by clearing `SILENT_CHANNEL_IDS` and deploying. That restores acks and wakes for the channel.

`node-http-relay` imports this module, so the same variable mutes there too. Socket Mode checks the variable at the start of `app_mention` and `message`, before thinking status. The live host is the Worker.

## Private-room slash command

`POST /slack/commands` accepts `/privroom`. `PRIVROOM_COMMANDS` is an optional comma-separated list of extra names, for example `/sample-ask,/sample-ask-2`. `/privroom` stays accepted. A blank value, or a value whose tokens are all invalid, adds nothing. A token must be `/` plus 1–32 letters, digits, underscores, or hyphens. Anything else is dropped.

An accepted command with text posts `PRIVROOM_MENTION_TAGS`, or `<@userId>` from `PRIVROOM_BOTS` when that string is unset, plus the question, in the channel Slack sent. A muted channel gets an ephemeral reply and no post. The Worker stores `privroom:<channel>:<ts>` and enqueues `PRIVROOM_SYNTH` for `PRIVROOM_DELAY_SECONDS` (default 300). The first of “every configured bot replied” or the timer wakes once with `kind: "privroom_synthesize"`. Fields are `source`, `kind`, `channel`, `thread_ts`, `question`, `invoker`, `replied`, `missing`, and `reason` (`all_replied` or `timer`). That kind is generic. It is not a room name.

## Thread ownership

A thread this bot owns wakes on a later human reply that does not @mention anyone. Two starts create that ownership, both stored in `PRIVROOM_STATE` for 7 days (`sticky:<channel>:<root ts>`):

- A person @mentions only this bot. Mentioning this bot and someone else does not take the thread.
- This bot posts the root message. Slack delivers that post back as a `message` event (`bot_message`, this bot's user id or bot id, no parent `thread_ts`). The Worker marks the thread and does not wake. The same mark is written when this Worker itself posts a root `chat.postMessage` (no `thread_ts`).

A post that only replies inside an existing thread (`thread_ts` different from `ts`) does not take that thread. If a mark is already stored, a later root event does not replace it. An @mention of someone else wakes with `sticky_other_tag: true` and leaves the mark in place, so the next untagged human reply still wakes. Messages from any bot, including this one, never wake.

`STICKY_THREADS=0`, `false`, or `off` disables it. The KV binding has to be named `PRIVROOM_STATE`. `OWN_USER_ID` (or a successful `auth.test`) has to identify this bot. `message.channels` must be subscribed or Slack will not deliver the bot's own root post; private channels need `message.groups` as well. No separate callback from the reply routine is required. A conversation this bot opens on its own is a top-level `chat.postMessage` with no `thread_ts`. A 1:1 answer uses `routing` instead. A send that sets `thread_ts` is a reply and does not claim. Muted channels return before this runs, so they neither claim nor wake. `SILENT_RECORD`, `ACK_REACTION`, and `HOLD_ACK` are independent: leave them as set in untracked runtime config. `HOLD_ACK` stays off unless that var is true. The ack reaction stays whatever `ACK_REACTION` names.

## Assistant panel

Slack's agent and assistant container is a DM. This Worker does not wake on `assistant_thread_started`, `assistant_thread_context_changed`, `app_context_changed`, or `app_home_opened`.

- `assistant_thread_started` posts `ASSISTANT_GREETING` into that thread and calls `assistant.threads.setSuggestedPrompts`. The greeting default is `Hi. Ask a question, or choose a prompt.` Prompts default to two generic ones. `ASSISTANT_PROMPTS` is a JSON list of `{title, message}` (at most four). `ASSISTANT_GREETING=off` skips the post. `ASSISTANT_PANEL=0` skips all of this.
- Prompts omit `thread_ts`. Agents & AI Apps silently ignore the call when `thread_ts` is set. Set `ASSISTANT_PROMPTS_IN_THREAD=1` only for a legacy assistant container.
- `app_home_opened` with `tab` `messages` refreshes those prompts and posts the greeting once per DM, which is how an agent app learns the Messages tab was opened. The Home tab is ignored. The once-only mark needs `PRIVROOM_STATE`.
- `assistant_thread_context_changed` stores the viewed channel only on `assistant:<dm channel>:<thread ts>` for 30 days, and only when both ids are present. It does not post and does not read that channel. `app_context_changed` has no thread id. The Worker drops it. It is not applied to a later DM.
- A `message.im` in a thread Slack named that way wakes with `routing.surface` `assistant_thread`, `routing.reply_broadcast` false, and `assistant.context` from that thread only. The routine posts into that thread, including a delayed result, and does not copy it to the main DM.
- Any other DM thread is `routing.surface` `im_thread`. Answer in that thread. Do not attach panel context, even if a per-user record or a different thread has one.
- A top-level `message.im` is `routing.surface` `im` with `reply_thread_ts` null, including a Messages-tab message that has no `assistant_thread` field. If that event includes `app_context` or `context`, `routing.viewed` carries it and `viewed_source` is `event`. The next message does not inherit it. A delayed result stays in the main DM and is not broadcast.
- While that wake runs, the Worker calls `assistant.threads.setStatus` with `is thinking…` on the DM thread, then clears it with an empty status after the webhook returns. The ack reaction and `HOLD_ACK` are unchanged. `HOLD_ACK` stays off unless set true.
- The bot's own messages, including the greeting, do not wake.

Subscribe to bot events `assistant_thread_started`, `assistant_thread_context_changed`, `app_home_opened`, `app_context_changed`, and `message.im`. `assistant:write` is the scope for prompts and status. `app_context_changed` also requires that scope and `agent_view`. The relay does not subscribe for you. It does not handle `agent_session_stopped`; without that subscription Slack shows a loading indicator with no stop button. A viewed channel that is muted is not fetched. Its id can still appear on `assistant.context`.

## Private record (off by default)

`SILENT_RECORD` defaults to `"0"`. It does not read `HONCHO_INGEST` or `HONCHO_READ`. Leave it off until the mute is what the live Worker is running, `message.groups` is subscribed, the bot token has `groups:history`, and you have watched one new message log `honcho record ok` without a Slack reaction. Turning it on calls Honcho, so set `HONCHO_API_KEY` first. Mentions already arrive as `app_mention`. Ordinary private-channel messages do not arrive until those two Slack settings are verified. This repo does not change the Slack app.

When the switch is on, a muted channel is written to the **same** Honcho workspace (no second workspace) as session `record-<channelId>` and peer `rec-<channelId>-<slackUserId>`. The Slack user id is metadata for the owner view, not the Honcho peer id. The public session `channel-<id>` is not used. Setup sends session configuration `reasoning.enabled`, `summary.enabled`, `dream.enabled` false and `peer_card.create` / `use` false, session-peer `observe_me` and `observe_others` false, and message `reasoning.enabled` false. Honcho v3.6 documents message config as the highest layer and `observe_me` defaulting to true; the deriver skips a representation only when the effective flag is false, and summaries are a separate queue, which is why summary is disabled explicitly. The session PUT and the peer-config PUT must succeed or the message is not posted, and the code does not fall back to public ingest. Wake reads (`HONCHO_READ`) return `silent` and do not fetch `record-<id>`.

That does not prove the hosted service has no other workspace-wide reader. Do not enable the switch until that limit is accepted.

### Explicit lookup only

Nothing in a wake payload, including an owner DM that does not ask, includes this session. A search has to name the channel (its id or `SILENT_CHANNEL_ALIASES`) and use history language (`search`, `history`, `what was said`, …). The Worker checks Slack's `user` and `channel_type: im` on a `D…` channel. Text that claims a name is ignored. Readers are `SILENT_CHANNEL_READERS` (`CHANNEL:USER|USER`). Example only — these ids are synthetic. Real ids stay in untracked runtime config:

```toml
SILENT_CHANNEL_IDS = "C0SYNTH0001"
SILENT_RECORD = "0"   # set "1" only after the checks above
SILENT_CHANNEL_ALIASES = "C0SYNTH0001:record-room|record room"
SILENT_CHANNEL_READERS = "C0SYNTH0001:U0SYNTH0001|U0SYNTH0002|U0SYNTH0003|U0SYNTH0004"
SILENT_GROK_READER_IDS = "U0SYNTH0001"
```

An allowed 1:1 DM gets one `chat.postMessage` back from the Worker in that DM (no `reply_broadcast`, no reaction, no wake). That lookup reply is the Worker's own message, not the routine's answer route. Other surfaces get nothing from this store. The configured owner's private Grok chat can call `queryRecordSession(env, { source: "owner-grok", requesterId, channelId })`, which returns session messages and null peer fields. Do not expose that function on HTTP. Render it only in that chat.

### Catch-up since channel creation

Honcho stays empty for this channel until `SILENT_RECORD` is on. Messages already in `log/raw/*.jsonl` are not a Honcho backlog. After one live `honcho record ok`, and only then, replay **this channel** from its creation timestamp. `--since` is required. Other channels in the same files are skipped. A plain `--write` refuses muted ids and must not be used for this.

```bash
node --env-file=.env scripts/honcho-backfill.mjs --record-only \
  --channel C0SYNTH0001 --since <creation slack ts> --dir log/raw
node --env-file=.env scripts/honcho-backfill.mjs --record-only --write \
  --channel C0SYNTH0001 --since <creation slack ts> --dir log/raw
```

Dry-run prints `peer_id` values that start with `rec-` and `session_id` `record-C0SYNTH0001`. If a line shows a raw `U…` peer id, do not pass `--write`. This is not a full-history import.

Deploy this the same way as the mute: cherry-pick onto the source that matches the running Worker (`2b1c4525` is not in this repo). Do not `wrangler deploy` this git tree over that script.

## Honcho ingest (off by default)

`HONCHO_INGEST` in `[vars]` defaults to `"0"`. Public-channel writes run inside `ctx.waitUntil` after the Worker has already built the `200` response. `wakeGrok` does not call Honcho. Ingest itself does not read.

### Optional wake-path reads (off by default)

`HONCHO_READ` is independent of `HONCHO_INGEST` and defaults to `"0"`. When it is `"1"`, `processInbound` and `forwardWatched` GET the per-channel session (`channel-<id>`) and attach the result as `payload.honcho` before `wakeGrok`. `HONCHO_READ_TIMEOUT_MS` defaults to `1500` and is capped at `15000`. A missing key, HTTP error, or timeout still wakes Grok with `honcho.ok === false`. The read runs in `ctx.waitUntil`, so the Slack `200` is not delayed. Socket Mode stays write-only; this read hook is on the Worker module, which `node-http-relay` imports.

Honcho stays off unless you opt in. `HONCHO_INGEST`, `HONCHO_READ`, and `SILENT_RECORD` each default off. Record-only capture does not check the other two: `ingestSilentIfEnabled` runs when `SILENT_RECORD` is on, and `sendRecord` posts to Honcho with `HONCHO_API_KEY`. An allowed record search calls `queryRecordSession`, which uses that same key and does not check ingest or read. With all three switches off, do not set the key; nothing calls Honcho. Set the key with `npx wrangler secret put`, not in `wrangler.toml`, only when you enable ingest, wake reads, or record-only capture.

`HONCHO_CHANNEL_IDS` is optional. Set it to comma-separated public channel ids. The current bot token gets `missing_scope` from `conversations.info` (no `channels:read`). Events that already include `channel_type: channel` still ingest. `app_mention` often has no type: those are ingested only when the channel id is in `HONCHO_CHANNEL_IDS`, or when `conversations.info` succeeds and says the channel is public. A failed lookup does not treat a `C` id as public, so a group-DM mention is not written. Wake routing is unchanged.

1. Keep `HONCHO_INGEST` at `"0"` and deploy.
2. In Slack, **Event Subscriptions → Subscribe to bot events**, add `message.channels` if it is not already there. Save. Reinstall only if Slack asks. Do not add `message.groups` for this phase (private channels are filtered out). The bot must already be in the channel. `channels:history` is the matching scope (already on the sample manifest).
3. Dry-run history from the repo root. Pass the public channel ids, because log rows have no `channel_type` and `conversations.info` fails closed without `channels:read`:
   `node --env-file=.env scripts/honcho-backfill.mjs --dry-run --channel-ids C0123,C0456`
   `--write` posts. The script does not use the Worker. A `BOT_NAME` label in the log is written as `OWN_USER_ID` (or `auth.test` `user_id`), not as that label.
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
