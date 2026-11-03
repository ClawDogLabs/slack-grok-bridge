/**
 * node-http-relay — run the Slack Events API relay on any Node 20+ host (VPS, Fly.io, Railway,
 * Render, Cloud Run, ...) instead of Cloudflare Workers.
 *
 * It is a thin adapter: the verify / url_verification / route / forward-to-Grok logic is the same
 * module as the Worker (../cloudflare-relay/src/index.js). This file only turns Node's
 * http.IncomingMessage into a web Request, passes process.env as the Worker `env`, and keeps
 * background work (ctx.waitUntil) alive in the long-running process.
 *
 * Config: the same names as the Worker's secrets and [vars], read from the environment.
 *   Required: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GROK_WEBHOOK_URL
 *   Recommended: GROK_WEBHOOK_SECRET
 *   Server: PORT (default 8080), HOST (default 0.0.0.0)
 *
 * Plain HTTP on purpose: put it behind your host's HTTPS (Fly/Railway/Render/Cloud Run do this
 * for you) or a reverse proxy such as Caddy on a VPS. Slack requires an https:// Request URL.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import worker from "../cloudflare-relay/src/index.js";

const MAX_BODY = 1024 * 1024; // Slack event payloads are far smaller

export function createRelayServer(env = process.env) {
  const pending = new Set();
  const ctx = {
    waitUntil(p) {
      const tracked = Promise.resolve(p).catch((err) => console.error("background error", err?.message || err)).finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { res.writeHead(413).end("payload too large"); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const response = await worker.fetch(request, env, ctx);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error("request error", err?.message || err);
      if (!res.headersSent) res.writeHead(500);
      res.end("internal error");
    }
  });

  /** Wait (up to timeoutMs) for in-flight webhook / Slack calls, e.g. on SIGTERM during a deploy. */
  server.drain = (timeoutMs = 10000) =>
    Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "0.0.0.0";
  const server = createRelayServer(process.env);
  server.listen(port, host, () => {
    const ok = !!(process.env.SLACK_SIGNING_SECRET && process.env.GROK_WEBHOOK_URL && process.env.SLACK_BOT_TOKEN);
    console.log(`slack-grok node-http-relay listening on ${host}:${port} (configured: ${ok})`);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      server.close();
      await server.drain();
      process.exit(0);
    });
  }
}
