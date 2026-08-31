import assert from "node:assert/strict";
import test from "node:test";

import { extractVideoTaskIds, buildVideoContent, isVideoModel, isVideoChat, toolName, VIDEO_TOOL, VIDEO_TOOL_NAME, VIDEO_URL_RE } from "../video.js";
import { extractToolCalls } from "../toolparse.js";

// The interception in server.js only works if the virtual tool is in the SAME
// list the parser validates against. Injected into the prompt but not the
// registry, every generate_video call is silently discarded as prose.
test("generate_video parses only when VIDEO_TOOL is in the registry", () => {
  const block = '{"name": "generate_video", "arguments": {"prompt": "a cat"}}';
  const clientTools = [{ type: "function", function: { name: "read", parameters: {} } }];

  assert.deepEqual(extractToolCalls(block, clientTools), [], "unregistered call must not parse");

  const withVideo = extractToolCalls(block, [...clientTools, VIDEO_TOOL]);
  assert.equal(withVideo.length, 1);
  assert.equal(withVideo[0].name, VIDEO_TOOL_NAME);
  assert.equal(JSON.parse(withVideo[0].arguments).prompt, "a cat");
});

test("toolName reads both OpenAI and bare tool shapes", () => {
  assert.equal(toolName(VIDEO_TOOL), "generate_video");
  assert.equal(toolName({ name: "read" }), "read");
  assert.equal(toolName(undefined), "");
});

test("isVideoModel matches the -video suffix convention only", () => {
  for (const m of ["wan3.0-video", "wan2.5-video", "qwen3.8-max-video"]) {
    assert.equal(isVideoModel(m), true, m);
  }
  for (const m of ["qwen3.8-max", "qwen-image-3.0", "wan3.0-video-preview", "", null, undefined]) {
    assert.equal(isVideoModel(m), false, String(m));
  }
});

test("isVideoChat covers i2v, not just t2v", () => {
  assert.equal(isVideoChat([{ chat_type: "t2v" }]), true);
  assert.equal(isVideoChat([{ chat_type: "i2v" }]), true);
  assert.equal(isVideoChat([{ chat_type: "t2t" }]), false);
  assert.equal(isVideoChat([{ chat_type: "t2i" }]), false);
  assert.equal(isVideoChat([]), false);
  assert.equal(isVideoChat(undefined), false);
});

// Every shape upstream has been observed to use. The first is what the proxy
// used to be the only handler for; the rest silently returned no id.
test("extractVideoTaskIds finds the id in each upstream shape", () => {
  const cases = [
    ['{"data":{"messages":[{"extra":{"wanx":{"task_id":"wanx-1"}}}]}}', "wanx-1"],
    ['{"task_id":"bare-1"}', "bare-1"],
    ['{"taskId":"camel-1"}', "camel-1"],
    ['{"output":{"task_id":"out-1"}}', "out-1"],
    ['{"result":{"taskId":"res-1"}}', "res-1"],
    ['{"results":[{"task_id":"arr-1"}]}', "arr-1"],
    ['{"id":"stat-1","task_status":"PENDING"}', "stat-1"],
    ['{"id":"run-1","status":"running"}', "run-1"],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(extractVideoTaskIds(raw), [expected], raw);
  }
});

test("extractVideoTaskIds reads unparseable SSE frames via regex", () => {
  const sse = 'data: {"task_id":"sse-1"}\n\ndata: {"task_id":"sse-2"}\n\n';
  assert.deepEqual(extractVideoTaskIds(sse), ["sse-1", "sse-2"]);
});

test("extractVideoTaskIds tolerates unquoted keys", () => {
  assert.deepEqual(extractVideoTaskIds("task_id=plain-1 done"), ["plain-1"]);
  assert.deepEqual(extractVideoTaskIds("taskId: plain-2"), ["plain-2"]);
});

test("extractVideoTaskIds dedupes and keeps order", () => {
  const raw = '{"task_id":"a","output":{"task_id":"a"},"result":{"task_id":"b"}}';
  assert.deepEqual(extractVideoTaskIds(raw), ["a", "b"]);
});

test("extractVideoTaskIds returns empty when there is no task", () => {
  for (const raw of ["", null, undefined, "plain text", '{"id":"not-a-task"}', "{}"]) {
    assert.deepEqual(extractVideoTaskIds(raw), [], String(raw));
  }
});

test("buildVideoContent puts the URL in src with fallback link inside video tag", () => {
  const url = "https://cdn.qwenlm.ai/output/abc/video.mp4";
  const content = buildVideoContent(url);
  assert.match(content, /<video controls="controls" src="https:\/\/cdn\.qwenlm\.ai\/output\/abc\/video\.mp4"><a href="https:\/\/cdn\.qwenlm\.ai\/output\/abc\/video\.mp4">Download Video<\/a><\/video>/);
  assert.equal(content.match(VIDEO_URL_RE)[1], url);
});

// A signed URL's `&` would otherwise be read as a character reference: `&copy=1`
// becomes `©=1` and the video 404s.
test("buildVideoContent escapes ampersands in src and href attributes", () => {
  const content = buildVideoContent("https://cdn.qwenlm.ai/v.mp4?key=abc&copy=1&reg=2");
  assert.match(content, /src="https:\/\/cdn\.qwenlm\.ai\/v\.mp4\?key=abc&amp;copy=1&amp;reg=2"/);
  assert.match(content, /href="https:\/\/cdn\.qwenlm\.ai\/v\.mp4\?key=abc&amp;copy=1&amp;reg=2"/);
});
