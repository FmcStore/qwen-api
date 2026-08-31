// Unit tests for store.js size capping.
// Run: node --test tests/store.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// store.js reads env at module load — configure before importing
const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qwen-store-")), "memory.json");
process.env.MEMORY_FILE = tmpFile;
process.env.QWEN_MEMORY_MAX_BYTES = "2000";
const store = await import("../store.js");

test("byte cap drops oldest conversations but never the active one", async () => {
  const big = (m) => [{ role: "user", content: "x".repeat(600) }, { role: "assistant", content: m }];

  for (let i = 1; i <= 8; i++) await store.saveHistory(`conv-${i}`, big(`conv ${i} answer`));
  // last save: active conv-8 plus one older survivor must fit in 2000 bytes
  await store.saveHistory("conv-8", big("final answer"));

  const raw = fs.readFileSync(tmpFile, "utf8");
  assert.ok(Buffer.byteLength(raw) <= 2000, `file is ${Buffer.byteLength(raw)} bytes, cap 2000`);
  const data = JSON.parse(raw);
  assert.ok(data["conv-8"], "active conversation preserved");
  assert.equal(data["conv-8"].at(-1).content, "final answer");
  assert.ok(Object.keys(data).length < 8, "older conversations were dropped to fit the cap");
});

test("message-per-conversation cap keeps only the last 50", async () => {
  const msgs = Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `m${i}` }));
  await store.saveHistory("cap-test", msgs);
  const history = store.getHistory("cap-test");
  assert.equal(history.length, 50);
  assert.equal(history[0].content, "m10");
  assert.equal(history.at(-1).content, "m59");
});

test("clearConversation removes and reports existence", async () => {
  await store.saveHistory("gone", [{ role: "user", content: "bye" }]);
  assert.equal(store.clearConversation("gone"), true);
  assert.equal(store.clearConversation("gone"), false);
  assert.deepEqual(store.getHistory("gone"), []);
});
