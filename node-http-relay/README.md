# node-http-relay — the Slack → Grok relay without Cloudflare

A plain **Node 20+** HTTP server that does exactly what [`../cloudflare-relay/`](../cloudflare-relay/README.md)
does: verify Slack's signature, answer `url_verification`, ack fast, and forward events to your
Grok Bot routine webhook. It **imports the Worker module** (`../cloudflare-relay/src/index.js`), so
routing, payload, headers, retry policy and hold-ack behavior are identical. `server.js` is only
an adapter (Node request → web `Request`, `process.env` → `env`, a real `ctx.waitUntil`).

No dependencies. Use it on any host that keeps a process running: Fly.io, Railway, Render,
Google Cloud Run, or a VPS. See [`../HOSTING.md`](../HOSTING.md) to decide if you need a relay at all.

```
Slack ──HTTPS (signed)──▶ your host's TLS ──▶ node server.js ──POST + key──▶ Grok routine webhook
```

## Config

Environment variables, same names as the Worker (see [`.env.example`](./.env.example) and
[`../cloudflare-relay/wrangler.toml.example`](../cloudflare-relay/wrangler.toml.example) for the optional ones):

| Var | Required | Notes |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | yes | api.slack.com → your app → Basic Information → Signing Secret. Missing → every POST gets `503` (fails closed). |
| `SLACK_BOT_TOKEN` | yes | `xoxb-…`, for user lookups, thinking status and hold-ack. |
| `GROK_WEBHOOK_URL` | yes | Your Grok routine's webhook URL. |
| `GROK_WEBHOOK_SECRET` | recommended | Sent as `Authorization: Bearer …` and `X-Automation-Key`. |
| `PORT` / `HOST` | no | Default `8080` / `0.0.0.0`. |

Set them with your host's secret store, never in git.

## Run locally

```bash
cd node-http-relay
npm test                                # offline tests, localhost only
cp .env.example .env && chmod 600 .env  # fill in values
node --env-file=.env server.js
curl -s localhost:8080/health           # {"ok":true,...,"configured":true}
```

To try it with real Slack, expose it with a tunnel (`ngrok http 8080` or `cloudflared tunnel --url
http://localhost:8080`) and use `https://<tunnel-host>/slack/events` as the Request URL. Tunnels
are for testing; for production the relay must run on an always-on host.

## Deploy

The Dockerfile must be built from the **repo root** (it copies the shared Worker module):

```bash
docker build -f node-http-relay/Dockerfile -t slack-grok-relay .
```

**Fly.io**

```bash
fly launch --no-deploy --dockerfile node-http-relay/Dockerfile   # from the repo root; internal port 8080
fly secrets set SLACK_SIGNING_SECRET=... SLACK_BOT_TOKEN=... GROK_WEBHOOK_URL=... GROK_WEBHOOK_SECRET=...
# in fly.toml [http_service]: auto_stop_machines = "off", min_machines_running = 1
fly deploy
```

**Railway / Render**: create a service from your fork, set the Dockerfile path to
`node-http-relay/Dockerfile` (build context = repo root), add the env vars, and use an always-on
instance (Railway: app sleeping off; Render: not the free tier, which spins down when idle).

**Google Cloud Run**: build/push the image, deploy with `--port 8080`, secrets via Secret Manager,
and **instance-based billing / CPU always allocated** (`--no-cpu-throttling`) so the webhook POST
that runs after the ack isn't starved. `--min-instances=1` avoids cold starts.

**VPS**: `node --env-file=/etc/slack-grok-relay.env server.js` under systemd (or pm2 / Docker with
`--restart unless-stopped`), behind a reverse proxy for HTTPS, e.g. Caddy:

```
relay.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

## Then switch Slack to HTTP delivery

Same steps as the Worker: [`../cloudflare-relay/README.md#switch-the-slack-app-to-http-delivery`](../cloudflare-relay/README.md#switch-the-slack-app-to-http-delivery),
with Request URL `https://<your-host>/slack/events`. Smoke test first: an unsigned POST must return `401`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-host>/slack/events -d '{}'
```

## Other platforms (Lambda, Cloud Functions, Azure Functions, Deno Deploy)

Write the same kind of adapter as `server.js`: build a web `Request` with the **raw** body, pass
an `env` object, and provide `ctx.waitUntil`. Functions that freeze right after responding will
drop that background work, so use the platform's background primitive, finish the forward before
responding (within Slack's 3 s), or hand off to a queue. Details in [`../HOSTING.md`](../HOSTING.md).
