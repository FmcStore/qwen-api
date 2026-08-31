// Unit tests for the Anthropic <-> OpenAI tool-calling translation layer.
// Run: node --test tests/anthropic_tools.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  translateAnthropicToOpenAI,
  AnthropicStreamEncoder,
  buildAnthropicResponse,
} from "../anthropic.js";

function mockRes() {
  return { chunks: [], write(s) { this.chunks.push(s); } };
}

function parseSSE(chunks) {
  const events = [];
  for (const c of chunks.join("").split("\n\n")) {
    const line = c.split("\n").find((l) => l.startsWith("data: "));
    if (line) events.push(JSON.parse(line.slice(6)));
  }
  return events;
}

const anthropicToolRequest = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  system: [{ type: "text", text: "You are a coding agent." }],
  tools: [{
    name: "get_weather",
    description: "Get weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }],
  tool_choice: { type: "any" },
  messages: [
    { role: "user", content: [{ type: "text", text: "Weather in Rome?" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "should call the tool" },
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Rome" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "25C sunny" }] },
        { type: "text", text: "Great, thanks!" },
      ],
    },
  ],
};

test("translateAnthropicToOpenAI: tools, tool_choice, tool_use, tool_result round-trip shapes", () => {
  const out = translateAnthropicToOpenAI(anthropicToolRequest);

  // system array -> single system string
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "You are a coding agent.");

  // tools -> OpenAI function shape
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "get_weather");
  assert.deepEqual(out.tools[0].function.parameters, anthropicToolRequest.tools[0].input_schema);

  // tool_choice any -> required
  assert.equal(out.tool_choice, "required");

  // user text turn
  assert.deepEqual(out.messages[1], { role: "user", content: "Weather in Rome?" });

  // assistant turn: thinking stripped, text kept, tool_use -> tool_calls
  const assistant = out.messages[2];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "Let me check.");
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, "toolu_1");
  assert.equal(assistant.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { city: "Rome" });
  assert.ok(!JSON.stringify(assistant).includes("thinking"));

  // tool_result -> standalone role:"tool" message with resolved tool name, then a fresh user turn
  const toolMsg = out.messages[3];
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "toolu_1");
  assert.equal(toolMsg.name, "get_weather");
  assert.equal(toolMsg.content, "25C sunny");
  assert.deepEqual(out.messages[4], { role: "user", content: "Great, thanks!" });
});

test("translateAnthropicToOpenAI: forced tool_choice and image sources", () => {
  const out = translateAnthropicToOpenAI({
    tool_choice: { type: "tool", name: "get_weather" },
    stop_sequences: ["\n\nHuman:"],
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
      ],
    }],
  });
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: "get_weather" } });
  assert.deepEqual(out.stop, ["\n\nHuman:"]);
  assert.equal(out.messages[0].content[0].image_url.url, "data:image/png;base64,QUJD");
  assert.equal(out.messages[0].content[1].image_url.url, "https://example.com/cat.png");
});

test("AnthropicStreamEncoder: text + tool_calls deltas emit spec-valid event sequence", () => {
  const res = mockRes();
  const enc = new AnthropicStreamEncoder(res, "claude-test", "msg_1", { inputTokens: 42 });

  enc.delta({ content: "Checking " });
  enc.delta({ content: "the weather." });
  enc.delta({
    tool_calls: [{
      index: 0,
      id: "call_abc",
      type: "function",
      function: { name: "get_weather", arguments: "{\"city\":\"Rome\"}" },
    }],
  });
  enc.delta({ content: " done" }); // text after a tool block must open a NEW text block
  enc.finish("tool_calls");

  const events = parseSSE(res.chunks);
  assert.equal(events[0].type, "message_start");
  assert.equal(events[0].message.usage.input_tokens, 42);

  const starts = events.filter((e) => e.type === "content_block_start");
  assert.equal(starts.length, 3); // text, tool_use, text
  assert.equal(starts[0].content_block.type, "text");
  assert.equal(starts[1].content_block.type, "tool_use");
  assert.equal(starts[1].content_block.id, "call_abc");
  assert.equal(starts[1].content_block.name, "get_weather");
  assert.equal(starts[2].content_block.type, "text");

  // indexes strictly sequential
  assert.deepEqual(starts.map((s) => s.index), [0, 1, 2]);

  const jsonDeltas = events.filter((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta");
  assert.equal(jsonDeltas.length, 1);
  assert.equal(jsonDeltas[0].delta.partial_json, "{\"city\":\"Rome\"}");
  assert.equal(jsonDeltas[0].index, 1);

  const stops = events.filter((e) => e.type === "content_block_stop");
  assert.equal(stops.length, 3);

  const final = events[events.length - 2];
  assert.equal(final.type, "message_delta");
  assert.equal(final.delta.stop_reason, "tool_use");
  assert.ok(final.usage.output_tokens > 0);
  assert.equal(events[events.length - 1].type, "message_stop");

  // every content_block_stop must come after its block was started (no stop-before-start)
  const seenOpen = new Set();
  for (const e of events) {
    if (e.type === "content_block_start") seenOpen.add(e.index);
    if (e.type === "content_block_stop") assert.ok(seenOpen.has(e.index), `stop for unopened block ${e.index}`);
  }
});

test("AnthropicStreamEncoder: empty stream still emits one empty text block and end_turn", () => {
  const res = mockRes();
  const enc = new AnthropicStreamEncoder(res, "m", "id");
  enc.finish(null);
  const events = parseSSE(res.chunks);
  assert.ok(events.some((e) => e.type === "content_block_start" && e.content_block.type === "text"));
  assert.equal(events[events.length - 2].delta.stop_reason, "end_turn");
});

test("buildAnthropicResponse: tool calls become tool_use blocks with parsed input", () => {
  const r = buildAnthropicResponse("claude-test", "msg_2", "Checking.", [
    { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Rome\"}" } },
    { id: "call_2", type: "function", function: { name: "broken", arguments: "{not json" } },
  ]);
  assert.equal(r.stop_reason, "tool_use");
  assert.equal(r.content[0].type, "text");
  assert.deepEqual(r.content[1], { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Rome" } });
  assert.deepEqual(r.content[2].input, {}); // bad JSON degrades to empty input, not a crash
  assert.ok(r.usage.output_tokens > 0);
});

test("buildAnthropicResponse: no tools -> text-only end_turn", () => {
  const r = buildAnthropicResponse("claude-test", "msg_3", "Hello!");
  assert.equal(r.stop_reason, "end_turn");
  assert.deepEqual(r.content, [{ type: "text", text: "Hello!" }]);
});
