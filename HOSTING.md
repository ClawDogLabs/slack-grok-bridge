# Hosting options (with or without Cloudflare)

Slack can reach your Grok Bot in two ways. Both send the **same webhook payload and headers** to
the Grok routine, so the routine itself never changes. Only the receiving side does.

## Decision tree

```
Is there a host that is always on AND never sleeps/freezes?
│
├─ Yes ──▶ (a) Socket Mode bridge (index.js) on that host. No public URL needed.
│
└─ No (e.g. the Grok Bot computer pauses when idle)
     │
     ▶ (b) HTTP Events API through an always-on relay.
          │
          ├─ Have / want Cloudflare? ──▶ (c1) cloudflare-relay/ (Worker, free plan is fine)
          └─ No Cloudflare           ──▶ (c2) node-http-relay/ on Fly.io, Railway, Render,
                                            Cloud Run, a VPS, ... or a thin adapter on
                                            another serverless platform

Only need "wake on @mention / a phrase", no custom routing? ──▶ (d) built-in Grok Bot Slack trigger
Just testing locally?                                         ──▶ (e) tunnel (ngrok / cloudflared)
```

### (a) Socket Mode bridge — any always-awake host

`index.js` opens an outbound websocket to Slack, so it needs **no public URL, no TLS, no inbound
port**. Good hosts: a VPS, an always-running Fly Machine, Railway or Render (paid, non-sleeping
instance), a home server, or a desktop that never sleeps.

The catch: **Slack does not replay Socket Mode events.** Anything sent while the process or host is
down or frozen is lost. If your host sleeps, use (b).

### (b) HTTP Events API relay — when the bot's host sleeps

Slack POSTs each event to an HTTPS Request URL. A small always-on relay:

1. verifies Slack's `X-Slack-Signature` (HMAC with the signing secret),
2. answers the one-time `url_verification` challenge,
3. acks within Slack's 3-second deadline, and
4. POSTs the event to the Grok routine webhook with `Authorization: Bearer <secret>`.

Turn on **Delayed Events** in the Slack app so failed deliveries are retried for up to 24 hours.

**Why not point Slack straight at the Grok webhook?** Slack can't add custom headers (the
webhook needs its secret in `Authorization` / `X-Automation-Key`), and the webhook can't echo
Slack's `url_verification` challenge. The relay is the smallest thing that fixes both.

### (c) Where to run the relay

| Host | How | Notes |
| --- | --- | --- |
| **Cloudflare Workers** | [`cloudflare-relay/`](./cloudflare-relay/README.md) | Free plan is enough. `ctx.waitUntil` keeps background work alive after the ack. |
| **Fly.io** | [`node-http-relay/`](./node-http-relay/README.md) (Dockerfile) | Keep one machine running (`min_machines_running = 1`, auto-stop off) so background work isn't cut off. |
| **Railway** | `node-http-relay/` | Leave app sleeping / serverless mode **off**. |
| **Render** | `node-http-relay/` as a Web Service | Free instances spin down when idle; use a paid (always-on) instance. |
| **Google Cloud Run** | `node-http-relay/` container | Use instance-based billing ("CPU always allocated") so work after the response keeps CPU; `min-instances=1` avoids cold starts. |
| **Any VPS** | `node-http-relay/` behind Caddy or nginx for HTTPS | Run it under systemd, pm2, or Docker with restart policy. |
| **Deno Deploy, AWS Lambda + API Gateway, Google Cloud Functions, Azure Functions** | Thin adapter around `cloudflare-relay/src/index.js` | See below. |

`cloudflare-relay/src/index.js` is **Cloudflare Worker-shaped**: it exports
`fetch(request, env, ctx)`, uses web-standard `Request`/`Response`/`crypto.subtle`, reads config
from `env`, and defers slow work with `ctx.waitUntil`. Any other host needs a thin adapter that:

- builds a web `Request` from the platform's event (keep the **raw body** byte-for-byte, or the
  signature check fails),
- passes an `env` object with the same names (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`,
  `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_SECRET`, plus any optional vars),
- supplies a `ctx.waitUntil` that really keeps the promise running after the response.

`node-http-relay/server.js` is exactly this adapter for a long-running Node process (~80 lines).

**Serverless caveat:** platforms that freeze the function as soon as it returns a response (AWS
Lambda, most "functions" products) will drop `waitUntil` work. On those, either use the platform's
own background primitive if it has one, finish the webhook POST before responding (it must still
fit in Slack's 3 seconds), or hand the event to a queue / second async invocation. A long-running
container (Fly, Railway, Render, Cloud Run with CPU always allocated, a VPS) avoids the problem.

### (d) Built-in Grok Bot Slack routine trigger

If you connect Slack to your Grok Bot account, a routine can be triggered by Slack directly (for
example on a mention or a phrase). That needs **no custom bridge at all**, and is a good fit for
narrow "wake when X is said" cases. It is **not** a full replacement for Socket Mode / the Events
API relay: no custom routing rules, hold-ack messages, thinking status, bot-to-bot allowlists,
watched channels, welcome messages, or your own Slack app identity.

### (e) Tunnels (ngrok, cloudflared, ...)

Fine for **local testing** of the HTTP relay (e.g. `node node-http-relay/server.js` + a tunnel to
get an HTTPS Request URL). They do **not** fix sleep gaps in production: if the tunnel runs on the
machine that sleeps, Slack's deliveries fail while it's asleep. Only use one in production if the
tunnel endpoint itself runs on an always-on host — at which point you could run the relay there.

## Does this work with Muse (or other agents)?

No. This bridge targets **Grok Bot** routine webhooks (an inbound webhook authenticated with
`Authorization: Bearer` / `X-Automation-Key`). Meta's Muse agent has no documented equivalent
webhook that wakes the agent itself (as of late 2026 it is reached through the Muse app, the web,
or WhatsApp), so there is nothing for the bridge to POST to. OpenAI's Dots isn't this webhook
shape either. If an agent platform offers an authenticated "wake on POST" webhook, adapting the
forwarding step is straightforward, but nothing other than Grok Bot is supported or tested here.
