// Offline tests: no network. Run with `npm test` from cloudflare-relay/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWakeContext, honchoIngestEnabled, honchoReadEnabled } from "../src/honcho.js";

const env = {
  HONCHO_READ: "1",
  HONCHO_API_KEY: "hk-test",
  HONCHO_WORKSPACE_ID: "example-workspace",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("HONCHO_READ defaults off and is independent of ingest", () => {
  assert.equal(honchoReadEnabled({}), false);
  assert.equal(honchoReadEnabled({ HONCHO_READ: undefined }), false);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "" }), false);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "0" }), false);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "false" }), false);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "off" }), false);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "no" }), false);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "maybe" }), false);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "1" }), true);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "true" }), true);
  assert.equal(honchoReadEnabled({ HONCHO_READ: " YES " }), true);
  assert.equal(honchoReadEnabled({ HONCHO_READ: "on" }), true);
  assert.equal(honchoReadEnabled({ HONCHO_INGEST: "1" }), false);
  assert.equal(honchoIngestEnabled({ HONCHO_READ: "1" }), false);
});

test("happy path returns one channel session context", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return json({
      summary: { content: "Discussed the lab readout." },
      peer_representation: "A careful reviewer.",
      peer_card: ["asks short questions", "  ", "checks plots"],
      messages: [{ content: "first line" }, { content: "   " }, { content: "second line" }],
    });
  };
  const ctx = await fetchWakeContext(
    env,
    { channel: "Cpublic1", user: "Uhuman1", text: "hello", channelType: "channel" },
    { fetchImpl, timeoutMs: 50 },
  );
  assert.equal(ctx.ok, true);
  assert.equal(typeof ctx.ms, "number");
  assert.equal(ctx.sessionId, "channel-Cpublic1");
  assert.equal(ctx.summary, "Discussed the lab readout.");
  assert.equal(ctx.peer_representation, "A careful reviewer.");
  assert.deepEqual(ctx.peer_card, ["asks short questions", "checks plots"]);
  assert.deepEqual(ctx.recent, ["first line", "second line"]);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(
    `${url.origin}${url.pathname}`,
    "https://api.honcho.dev/v3/workspaces/example-workspace/sessions/channel-Cpublic1/context",
  );
  assert.equal(url.searchParams.get("tokens"), "1200");
  assert.equal(url.searchParams.get("summary"), "true");
  assert.equal(url.searchParams.get("peer_target"), "Uhuman1");
  assert.equal(calls[0].opts.method, "GET");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer hk-test");
  assert.equal(calls[0].opts.headers.Accept, "application/json");
  assert.equal(calls[0].url.includes("hk-test"), false);
});

test("timeout returns ok false and does not throw", async () => {
  const fetchImpl = async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };
  const ctx = await fetchWakeContext(
    env,
    { channel: "Cpublic1", user: "Uhuman1" },
    { fetchImpl },
  );
  assert.equal(ctx.ok, false);
  assert.equal(ctx.error, "timeout");
  assert.equal(ctx.sessionId, "channel-Cpublic1");
  assert.equal(typeof ctx.ms, "number");
});

test("http error is fail-open", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("nope", { status: 502 });
  };
  const ctx = await fetchWakeContext(
    env,
    { channel: "Cpublic1", user: "Uhuman1" },
    { fetchImpl },
  );
  assert.equal(calls, 1);
  assert.equal(ctx.ok, false);
  assert.equal(ctx.error, "http-502");
  assert.equal(ctx.sessionId, "channel-Cpublic1");
  assert.equal(typeof ctx.ms, "number");
});

test("no key and a bad channel do not call fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return json({ summary: "should not be read" });
  };
  const missing = await fetchWakeContext(
    { HONCHO_READ: "1", HONCHO_WORKSPACE_ID: "example-workspace" },
    { channel: "Cpublic1", user: "Uhuman1" },
    { fetchImpl },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "no-key");
  assert.equal(typeof missing.ms, "number");
  assert.equal(calls, 0);

  const bad = await fetchWakeContext(
    env,
    { channel: "not a channel", user: "Uhuman1" },
    { fetchImpl },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad-channel");
  assert.equal(calls, 0);
});
