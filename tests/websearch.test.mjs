// The virtual web_search tool: registry gating + the argument shape the model
// actually emits. Offline, part of `npm test`.
import assert from "node:assert/strict";
import test from "node:test";

import { SEARCH_TOOL, SEARCH_TOOL_NAME, searchQueryOf, buildSearchContent } from "../websearch.js";
import { extractToolCalls, normalizeName } from "../toolparse.js";
import { VIDEO_TOOL, toolName } from "../video.js";

const CLIENT_TOOLS = [{ type: "function", function: { name: "read", parameters: {} } }];

// The interception in server.js only works if the virtual tool is in the SAME
// list the parser validates against. In the prompt but not the registry, every
// web_search call is discarded — which is the capability gap this closes.
test("web_search parses only when SEARCH_TOOL is in the registry", () => {
  const block = '{"name": "web_search", "arguments": {"query": "bitcoin price"}}';
  assert.deepEqual(extractToolCalls(block, CLIENT_TOOLS), [], "unregistered call must not parse");

  const calls = extractToolCalls(block, [...CLIENT_TOOLS, SEARCH_TOOL]);
  assert.equal(calls.length, 1, "registered web_search did not parse");
  assert.equal(calls[0].name, SEARCH_TOOL_NAME);
  assert.equal(searchQueryOf(calls[0].arguments), "bitcoin price");
});

// The real captured generation (2026-08-25, chat d24c4b53). Qwen's own plugin
// signature is a PLURAL key holding an ARRAY, and that is what the model reaches
// for unprompted. Our schema declares a single `query` string, so nothing in the
// parse chain converts it — searchQueryOf is the only thing standing between
// this and a search for the empty string.
test("the plural array shape the model actually emits yields a query", () => {
  const block = '{"name": "web_search", "arguments": {"queries": ["current price of Bitcoin in USD"]}}';
  const calls = extractToolCalls(block, [...CLIENT_TOOLS, SEARCH_TOOL]);
  assert.equal(calls.length, 1, "captured generation no longer parses as a call");
  assert.equal(searchQueryOf(calls[0].arguments), "current price of Bitcoin in USD");
});

test("searchQueryOf tolerates the shapes, and refuses the empty ones", () => {
  assert.equal(searchQueryOf({ query: "  spaced  " }), "spaced");
  assert.equal(searchQueryOf({ queries: ["a", "b"] }), "a", "first query wins; the rest are logged as dropped");
  assert.equal(searchQueryOf({ queries: ["", "  ", "real"] }), "real", "blank entries must not win");
  assert.equal(searchQueryOf({ q: "short form" }), "short form");
  assert.equal(searchQueryOf('{"query":"double encoded"}'), "double encoded");
  assert.equal(searchQueryOf("bare string"), "bare string");
  // Nothing usable -> "" so the caller reports it instead of searching for it.
  assert.equal(searchQueryOf({}), "");
  assert.equal(searchQueryOf({ query: "   " }), "");
  assert.equal(searchQueryOf({ query: 42 }), "");
  assert.equal(searchQueryOf({ queries: [] }), "");
  assert.equal(searchQueryOf(null), "");
  assert.equal(searchQueryOf(undefined), "");
});

// server.js skips injecting a virtual tool whose NORMALIZED name a client
// already declared. Two schemas for one name would leave the client's own
// implementation racing ours, with only one of them wired to anything.
test("a client's own search tool collides on the normalized name", () => {
  const declared = new Set([{ function: { name: "webSearch" } }].map((t) => normalizeName(toolName(t))));
  assert.ok(declared.has(normalizeName(toolName(SEARCH_TOOL))), "camelCase webSearch must be seen as taken");
  assert.ok(!declared.has(normalizeName(toolName(VIDEO_TOOL))), "unrelated tool wrongly seen as taken");
});

test("buildSearchContent keeps the query visible and survives an empty answer", () => {
  const out = buildSearchContent("who won", "Someone did.");
  assert.match(out, /who won/);
  assert.match(out, /Someone did\./);
  assert.match(buildSearchContent("who won", "   "), /returned nothing/);
  assert.match(buildSearchContent("who won", null), /returned nothing/);
});

// The isolated chat runs with Qwen's native plugins on, so it narrates them: the
// first live run of this path came back with the answer plus a <tool_call> block
// for the search upstream had already done, and that block reached the client
// looking like a failed call. Verbatim tail from that run.
test("the isolated chat's own tool_call narration is stripped from the answer", () => {
  const withEcho = 'Bitcoin is around $79,000 [[1]].\n<tool_call>\n{"name": "web_search", "arguments": {"queries": \n[\n  "current price of Bitcoin in USD"\n]\n\n}}\n</tool_call>';
  const out = buildSearchContent("btc", withEcho);
  assert.doesNotMatch(out, /tool_call/, "plugin narration leaked into the reply");
  assert.match(out, /\$79,000/, "the answer itself was stripped with it");

  // Cut off by the end of the generation: same echo, no closing tag.
  const unclosed = 'Answer here.\n<tool_call>\n{"name": "web_search", "arg';
  assert.doesNotMatch(buildSearchContent("btc", unclosed), /tool_call/, "unclosed narration leaked");
  assert.match(buildSearchContent("btc", unclosed), /Answer here\./);

  // Echo and nothing else is not an answer.
  assert.match(buildSearchContent("btc", "<tool_call>{}</tool_call>"), /returned nothing/);
});

test("formatCitations converts [[n]] to domain markdown links and creates sources list", () => {
  const answer = "Barca won 5-0 [[1]]. Yamal played on right wing [2].";
  const searchInfo = [
    { index: 1, title: "ESPN Match Report", url: "https://espn.com/match1", hostname: "www.espn.com" },
    { index: 2, title: "Marca Player Ratings", url: "https://marca.com/ratings", hostname: "marca.com" },
  ];
  const out = buildSearchContent("barca elche", answer, searchInfo);
  assert.match(out, /\[espn\.com\]\(https:\/\/espn\.com\/match1\)/, "citation 1 domain link missing");
  assert.match(out, /\[marca\.com\]\(https:\/\/marca\.com\/ratings\)/, "citation 2 domain link missing");
  assert.match(out, /\*\*Sources:\*\*/, "sources header missing");
  assert.match(out, /1\. \[ESPN Match Report\]\(https:\/\/espn\.com\/match1\)/, "sources item 1 missing");
  assert.match(out, /2\. \[Marca Player Ratings\]\(https:\/\/marca\.com\/ratings\)/, "sources item 2 missing");
});
