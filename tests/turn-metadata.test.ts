import assert from "node:assert/strict";
import { test } from "bun:test";
import { getTurnMetadata, normalizeChatRequestBody } from "../src/chat/request";

const messages = [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }];

test("turn metadata is optional and the chat request remains unchanged", () => {
  const body = { session_id: "session-1", messages };

  assert.equal(getTurnMetadata(body), undefined);
  assert.equal(normalizeChatRequestBody(body).ok, true);
});

test("turn metadata exposes the current unverified user snapshot without changing chat behavior", () => {
  const metadata = {
    agent_id: "agent-1",
    user: { id: "visitor-1", display_name: "Alex", plan: "example" },
  };
  const body = { session_id: "session-1", messages, metadata };
  const normalized = normalizeChatRequestBody(body);

  assert.deepEqual(getTurnMetadata(body), metadata);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.equal("metadata" in normalized.request, false);

  const nextTurn = { ...body, metadata: { agent_id: "agent-1", user: { display_name: "Sam" } } };
  assert.deepEqual(getTurnMetadata(nextTurn)?.user, { display_name: "Sam" });
});

test("absent or malformed metadata does not reject a chat request", () => {
  for (const metadata of [null, "invalid", [], { user: null }, { user: "invalid" }]) {
    const body = { session_id: "session-1", messages, metadata };
    assert.equal(normalizeChatRequestBody(body).ok, true);
    if (metadata === null || typeof metadata === "string" || Array.isArray(metadata)) {
      assert.equal(getTurnMetadata(body), undefined);
    }
  }
});
