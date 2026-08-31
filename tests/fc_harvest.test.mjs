// Replays the real sse_todowrite fixture through the native-channel harvester
// and the streaming tool-buffer logic. Fails if a native call stops being
// recovered, if the canned rejection text leaks, or if snapshot accumulation
// regresses to `+=`.
//
// Part of `npm test` (offline tier). Live integration lives in
// ../test_agent_loop.js and ../test_client_thread.js at the repo root.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFCHarvester, extractToolCalls, pickGeneration, leftoverText, endsWithPartialToolTag } from "../toolparse.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name) =>
  fs.readFileSync(path.join(FIXTURES, name), "utf8").trim().split("\n");

const TODOWRITE_SCHEMA = [{
  type: "function",
  function: {
    name: "todowrite",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string" },
              priority: { type: "string" },
              id: { type: "string" },
            },
          },
        },
      },
      required: ["todos"],
    },
  },
}];

const frames = readFixture("sse_todowrite.jsonl")
  .map((l) => JSON.parse(l).event?.choices?.[0]?.delta)
  .filter(Boolean);

// --- replay: mirrors directRunCompletion's loop ------------------------------
const fc = makeFCHarvester();
let emitted = "";
for (const delta of frames) {
  emitted += fc.take(delta);
  if (fc.suppressed(delta)) continue;
  // `continue`, not `break`: "finished" ends a segment, not the response. This
  // capture raises it 3 times; sse_tui_run.jsonl raises it 16 times in one
  // generation. Measured 2026-08-24: no finished frame in any capture carries
  // content, so skipping the body here loses nothing.
  if (delta.status === "finished" && (!delta.phase || delta.phase === "answer")) continue;
  emitted += delta.content || "";
}
emitted += fc.flush();

// --- assertions -------------------------------------------------------------
assert.ok(!/does not exists/.test(emitted), "rejection text leaked to client");

const block = emitted.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
assert.ok(block, "no <tool_call> synthesized from the native channel");

const calls = extractToolCalls(block[1].trim(), TODOWRITE_SCHEMA);
assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
assert.equal(calls[0].name, "todowrite");
const args = JSON.parse(calls[0].arguments);
assert.ok(Array.isArray(args.todos), "todos not un-stringified into an array");
assert.equal(args.todos.length, 4, `expected 4 todos, got ${args.todos.length}`);
assert.ok(emitted.includes("alright Kovak"), "narration text lost");

// Snapshot semantics: the LAST frame's arguments is the whole payload, the
// concatenation of all of them is garbage.
const snaps = frames.filter((d) => d.function_call).map((d) => String(d.function_call.arguments || ""));
assert.doesNotThrow(() => JSON.parse(snaps.at(-1)), "last snapshot does not parse on its own");
assert.throws(() => JSON.parse(snaps.join("")), "concatenated snapshots parsed — capture changed shape");
assert.ok(snaps.join("").length > snaps.at(-1).length * 10, "frames are not snapshots — they look incremental");

// Two calls in one stream: a name change must flush, not overwrite.
const two = makeFCHarvester();
let out = two.take({ function_call: { name: "a", arguments: '{"x":1}' } });
out += two.take({ function_call: { name: "b", arguments: '{"y":2}' } });
out += two.flush();
// Internal plugins (image_edit, etc.) must NEVER be synthesized into tool calls.
const imgHarvester = makeFCHarvester();
let imgOut = imgHarvester.take({ function_call: { name: "image_edit", arguments: '{"prompt":"red hair"}' } });
imgOut += imgHarvester.flush();
assert.equal(imgOut, "", "internal plugin image_edit was synthesized into tool call");

console.log("PASS — native harvest, suppression gate, snapshot semantics, multi-call flush, internal plugin suppression");

// --- WAF challenge detection -------------------------------------------------
// A false positive here is expensive: the whole turn goes to the Puppeteer
// fallback, which is slow and can stream empty.
const { directChallengeMarker, challengeMarker } = await import("../ssxmod.js");
const fakeRes = (status, ct) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => ct } });

const SSE = "text/event-stream";
const innocent = "Here is the plan. Step 3 carries some risk, and the captcha page is unrelated.";

assert.equal(
  directChallengeMarker(fakeRes(200, SSE), innocent), null,
  "loose keyword in a 200 event-stream misread as a WAF block",
);
assert.equal(
  directChallengeMarker(fakeRes(200, SSE), '{"ret":["FAIL_SYS_USER_VALIDATE"]}'),
  "FAIL_SYS_USER_VALIDATE",
  "hard WAF marker missed inside a stream",
);
// Non-stream bodies are error pages — keep the loose scan there.
assert.equal(directChallengeMarker(fakeRes(200, "application/json"), innocent), "risk");
assert.equal(directChallengeMarker(fakeRes(200, "text/html"), ""), "text/html body");
assert.equal(directChallengeMarker(fakeRes(504, SSE), ""), "HTTP 504");
assert.equal(directChallengeMarker(fakeRes(403, "application/json"), ""), "HTTP 403");
assert.equal(challengeMarker(200, "all clear"), null);

console.log("PASS — challenge detection: streams keep hard markers only, error pages keep the loose scan");

// --- two generations in one body ---------------------------------------------
// sse_multigen.jsonl is a real capture of one 200 event-stream carrying two
// interleaved generations of the SAME turn: 748 chars complete, 517 chars cut
// off mid-JSON, each with its own "finished" frame.
const multi = readFixture("sse_multigen.jsonl")
  .map((l) => JSON.parse(l).event);

const winner = pickGeneration(multi);
assert.ok(winner, "two generations in the capture but pickGeneration chose none");

const textOf = (rid) => multi
  .filter((e) => e.response_id === rid)
  .map((e) => e.choices?.[0]?.delta?.content || "")
  .join("");

const won = textOf(winner);
assert.match(won, /<\/tool_call>/, "picked the generation that never closed its tool call");
assert.equal(
  (won.match(/<tool_call>/g) || []).length,
  (won.match(/<\/tool_call>/g) || []).length,
  "picked generation has unbalanced tool_call tags",
);
// The losing generation must not be along for the ride.
const others = [...new Set(multi.map((e) => e.response_id).filter(Boolean))].filter((r) => r !== winner);
assert.ok(others.length >= 1, "capture no longer has a second generation — pick a different fixture");
assert.ok(
  extractToolCalls(won.match(/<tool_call>([\s\S]*?)<\/tool_call>/)[1].trim(), TODOWRITE_SCHEMA).length === 1,
  "winning generation's tool call does not parse",
);

// Single generation -> no filtering, no behaviour change.
assert.equal(
  pickGeneration([{ response_id: "solo", choices: [{ delta: { content: "hi", phase: "answer" } }] }]),
  null,
  "filtered a stream that only had one generation",
);
// A title/summary sub-task with no answer text must never win.
assert.equal(
  pickGeneration([
    { response_id: "a", choices: [{ delta: { content: "", phase: "answer" } }] },
    { response_id: "b", choices: [{ delta: { content: "real answer", phase: "answer" } }] },
  ]),
  null,
  "an empty generation counted as a candidate",
);

console.log("PASS — multiplexed generations: the complete one wins, the truncated twin is dropped");

// --- one generation, many segments -------------------------------------------
// sse_multisegment.jsonl is one real generation (f60e7973, 165 frames) that
// raises status:"finished" 5 times in the answer phase as the model switches
// tools. Breaking on the first one kept 514 bytes and 1 call; reading through
// keeps 1731 bytes and 4. Both the parse loop and the response builder have to
// cope with the plural.
//
// replay(stopOnFinished) is ALSO the regression gate for the browser read loop
// (browser.js): it must keep reading past answer-phase "finished" exactly like
// the direct path does.
const seg = readFixture("sse_multisegment.jsonl")
  .map((l) => JSON.parse(l).event?.choices?.[0]?.delta).filter(Boolean);

const finishedFrames = seg.filter((d) => d.status === "finished" && (!d.phase || d.phase === "answer")).length;
assert.ok(finishedFrames > 1, "fixture no longer has multiple answer-phase finished frames");

const replay = (stopOnFinished) => {
  const h = makeFCHarvester();
  let out = "";
  for (const d of seg) {
    out += h.take(d);
    if (h.suppressed(d)) continue;
    if (d.status === "finished" && (!d.phase || d.phase === "answer")) {
      if (stopOnFinished) break;
      continue;
    }
    out += d.content || "";
  }
  return out + h.flush();
};

const blocksIn = (t) => [...t.matchAll(/<tool_calls?>([\s\S]*?)<\/tool_calls?>/gi)];
const stopped = blocksIn(replay(true));
const read = blocksIn(replay(false));
assert.ok(
  read.length > stopped.length,
  `reading past "finished" recovered no extra calls (${read.length} vs ${stopped.length}) — the segment fix regressed`,
);
// Mirrors the non-streaming extractor: it must collect EVERY block, and each
// must parse on its own.
for (const m of read) {
  assert.doesNotThrow(() => JSON.parse(m[1].trim()), `recovered block does not parse: ${m[1].slice(0, 80)}`);
}

console.log(`PASS — multi-segment generation: ${finishedFrames} "finished" frames, ${read.length} calls recovered (break kept ${stopped.length})`);

// --- an unclosed <tool_call> is prose, not silence ----------------------------
// Real generation, 2026-08-25 (chat d24c4b53, tools-on turn asking for a live
// Bitcoin price): the model reached for Qwen's own web_search and ended the call
// with </parameter></function> instead of </tool_call>. The close regex never
// matched, so inToolCall stayed true and every later piece was withheld for a
// tag that never came — 0 bytes to the client, finish_reason "stop", and no
// retry either (the empty-completion guard sees a non-empty buffer).
const UNCLOSED = 'I\'ll look that up.\n<tool_call>\n{"name": "web_search", "arguments": {"queries": [\n  "bitcoin price USD"\n]\n</parameter>\n</function>\n';
assert.doesNotMatch(UNCLOSED, /<\/tool_calls?>/i, "fixture must have no closing tag or it tests nothing");

// Mirrors the body.tools branch of the streaming onDelta in server.js, including
// its final leftoverText flush. `chunk` is the SSE frame boundary — vary it to
// prove a tag split mid-frame is held, not leaked.
//
// The default registry is a non-empty one on purpose: buildRegistry([]) is
// PERMISSIVE (any name parses), and the branch this mirrors only ever runs when
// the client declared tools. An empty list here would test the opposite gate.
const CLIENT_TOOLS = [{ type: "function", function: { name: "write", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
const replayBuffer = (text, chunk, tools = CLIENT_TOOLS) => {
  let buf = "", inTool = false, openTag = "<tool_call>", emitted = "";
  const calls = [];
  for (let i = 0; i < text.length; i += chunk) {
    buf += text.slice(i, i + chunk);
    const open = buf.match(/<tool_calls?>/i);
    if (!inTool && open) {
      if (open.index > 0) emitted += buf.substring(0, open.index);
      inTool = true;
      openTag = open[0];
      buf = buf.substring(open.index + open[0].length);
    }
    const close = buf.match(/<\/tool_calls?>/i);
    if (inTool && close) {
      const parsed = extractToolCalls(buf.substring(0, close.index).trim(), tools);
      // Zero calls means the registry rejected the name: re-emit verbatim.
      if (parsed.length) calls.push(...parsed);
      else emitted += openTag + buf.substring(0, close.index) + close[0];
      inTool = false;
      buf = buf.substring(close.index + close[0].length);
    }
    if (inTool) continue;
    if (endsWithPartialToolTag(buf)) continue;
    if (buf) { emitted += buf; buf = ""; }
  }
  return { emitted: emitted + leftoverText(buf, inTool, openTag), calls };
};

// Whatever the frame boundaries are, not one byte may go missing. chunk 4/7/9
// all land inside "<tool_call>" — the prefix list has to hold every one of them.
for (const chunk of [1, 4, 7, 9, 11, 13, UNCLOSED.length]) {
  const { emitted, calls } = replayBuffer(UNCLOSED, chunk);
  assert.equal(calls.length, 0, `chunk ${chunk}: unregistered web_search must not parse as a call`);
  assert.equal(emitted, UNCLOSED, `chunk ${chunk}: unclosed block did not round-trip verbatim`);
}

// A block that DOES close but names a tool nobody declared is the same story,
// and must stay that way — this is the closed-block twin of the bug above.
const CLOSED_UNKNOWN = 'sure.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "x"}}\n</tool_call>\ndone.\n';
for (const chunk of [3, 8, CLOSED_UNKNOWN.length]) {
  const { emitted, calls } = replayBuffer(CLOSED_UNKNOWN, chunk);
  assert.equal(calls.length, 0, `chunk ${chunk}: unregistered name parsed as a call`);
  assert.equal(emitted, CLOSED_UNKNOWN, `chunk ${chunk}: closed unknown block did not round-trip verbatim`);
}
// Same bytes, tool declared: now it is a call and none of it renders as text.
// Sweeping EVERY frame boundary is the point — the opening tag is 11 chars, so
// some chunk size lands inside it, and a prefix missing from PARTIAL_TOOL_TAGS
// emits the fragment and then never matches the open regex. That costs the call
// itself, not just tidiness, and bytes still round-trip while it happens, so
// only an assert on `calls` catches it.
const WEB_SEARCH_TOOL = { type: "function", function: { name: "web_search", parameters: { type: "object", properties: { query: { type: "string" } } } } };
for (let chunk = 1; chunk <= CLOSED_UNKNOWN.length; chunk++) {
  const { emitted, calls } = replayBuffer(CLOSED_UNKNOWN, chunk, [...CLIENT_TOOLS, WEB_SEARCH_TOOL]);
  assert.equal(calls.length, 1, `chunk ${chunk}: declared web_search did not parse — a tag prefix leaked mid-frame`);
  assert.equal(JSON.parse(calls[0].arguments).query, "x", `chunk ${chunk}: arguments lost`);
  assert.equal(emitted, "sure.\n\ndone.\n", `chunk ${chunk}: tool XML leaked into the text channel`);
}

// The flush decision itself: a lone opening tag carries no information, so it
// stays dropped — that path leaves the buffer empty and the empty-completion
// retry guard in server.js is what must fire, not this.
assert.equal(leftoverText("", true), "");
assert.equal(leftoverText("", false), "");
assert.equal(leftoverText("trailing prose", false), "trailing prose");
assert.equal(leftoverText('{"a":1}', true), '<tool_call>{"a":1}');
assert.equal(leftoverText('{"a":1}', true, "<tool_calls>"), '<tool_calls>{"a":1}', "opening tag not echoed as the model wrote it");

console.log("PASS — unclosed and unknown-name tool blocks round-trip as text at every frame boundary");
