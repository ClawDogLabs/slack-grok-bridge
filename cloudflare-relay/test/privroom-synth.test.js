import { test } from "node:test";
import assert from "node:assert/strict";
import {
  privroomSynthEnabled,
  matchPrivroomBot,
  buildPrivroomSynthPayload,
  slackSignature,
} from "../src/index.js";
import worker from "../src/index.js";

test("privroomSynthEnabled kill switch", () => {
  assert.equal(privroomSynthEnabled({}), true);
  assert.equal(privroomSynthEnabled({ PRIVROOM_SYNTHESIZE: "1" }), true);
  assert.equal(privroomSynthEnabled({ PRIVROOM_SYNTHESIZE: "0" }), false);
  assert.equal(privroomSynthEnabled({ PRIVROOM_SYNTHESIZE: "false" }), false);
  assert.equal(privroomSynthEnabled({ PRIVROOM_SYNTHESIZE: "off" }), false);
});

test("matchPrivroomBot by user id and bot id", () => {
  assert.equal(matchPrivroomBot({ user: "UPLACEHOLDER2" }).name, "Person");
  assert.equal(matchPrivroomBot({ bot_id: "BPLACEHOLDER2" }).name, "Valkyrie");
  assert.equal(matchPrivroomBot({ user: "UPLACEHOLDER4", bot_id: "BPLACEHOLDER3" }).name, "Person");
  assert.equal(matchPrivroomBot({ bot_id: "BPLACEHOLDER4" }).name, "Person");
  assert.equal(matchPrivroomBot({ user: "UPLACEHOLDER6", bot_id: "BPLACEHOLDER5" }), null); // Bot
  assert.equal(matchPrivroomBot({ user: "UHUMAN" }), null);
});

test("buildPrivroomSynthPayload shape", () => {
  const payload = buildPrivroomSynthPayload(
    { BRIDGE_SOURCE: "slack-bot-bridge" },
    {
      channel: "C1",
      ts: "111.222",
      question: "best bag?",
      invoker: "UINV",
      replied: ["Person", "Valkyrie"],
    },
    "timer",
  );
  assert.deepEqual(payload, {
    source: "slack-bot-bridge",
    kind: "privroom_synthesize",
    channel: "C1",
    thread_ts: "111.222",
    question: "best bag?",
    invoker: "UINV",
    replied: ["Person", "Valkyrie"],
    missing: ["Person", "Person"],
    reason: "timer",
  });
});

test("health reports privroom_synthesize flag", async () => {
  const res = await worker.fetch(
    new Request("https://relay.test/health"),
    { PRIVROOM_SYNTHESIZE: "1", SLACK_SIGNING_SECRET: "x", GROK_WEBHOOK_URL: "u", SLACK_BOT_TOKEN: "t" },
    { waitUntil() {} },
  );
  const body = await res.json();
  assert.equal(body.privroom_synthesize, true);
  const resOff = await worker.fetch(
    new Request("https://relay.test/health"),
    { PRIVROOM_SYNTHESIZE: "0" },
    { waitUntil() {} },
  );
  assert.equal((await resOff.json()).privroom_synthesize, false);
});

test("selftest disabled by default", async () => {
  const res = await worker.fetch(
    new Request("https://relay.test/internal/privroom-selftest", { method: "POST", body: "{}" }),
    {},
    { waitUntil() {} },
  );
  assert.equal(res.status, 404);
});
