import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function hashTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const h = createHash("sha256");
  for (const m of messages) {
    h.update(m?.role || "");
    h.update(":");
    h.update(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content || ""));
    h.update(":");
    if (m?.name) h.update(m.name);
    if (Array.isArray(m?.tool_calls)) h.update(JSON.stringify(m.tool_calls));
  }
  return "thash_" + h.digest("hex").slice(0, 32);
}

test("Phase 1: tool schema serialization has no multi-line indentation", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
      }
    }
  ];
  const minified = JSON.stringify(tools);
  assert.equal(minified.includes("\n"), false);
  assert.equal(minified.includes("  "), false);
  assert.equal(JSON.parse(minified)[0].function.name, "bash");
});

test("Phase 4: transcript continuation hash matches Turn N-1 completed state", () => {
  const turn1Msgs = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello world" }
  ];
  const assistantReply1 = "Hello! How can I assist you today?";

  const turn1CompletedHash = hashTranscript([...turn1Msgs, { role: "assistant", content: assistantReply1 }]);

  const turn2IncomingMsgs = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello world" },
    { role: "assistant", content: assistantReply1 },
    { role: "user", content: "What is 2+2?" }
  ];

  const turn2PrefixHash = hashTranscript(turn2IncomingMsgs.slice(0, -1));
  assert.equal(turn2PrefixHash, turn1CompletedHash);

  const branchedMsgs = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Different question" },
    { role: "assistant", content: "Different answer" },
    { role: "user", content: "What is 2+2?" }
  ];
  const branchedPrefixHash = hashTranscript(branchedMsgs.slice(0, -1));
  assert.notEqual(branchedPrefixHash, turn1CompletedHash);
});
