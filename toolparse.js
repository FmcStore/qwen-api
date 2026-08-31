// Registry-gated tool-call extraction with JSON repair and schema coercion.
//
// Adapted from UltraFEmotes/qwen3.8-api lib/tools.ts (method credit: Discord
// user .thereid). The two ideas that do most of the work:
//
//   * Nothing is a tool call unless its name is one of the declared tools.
//     An emulated protocol lives in the same channel as ordinary prose, so the
//     dangerous failure isn't a missed call, it's a false one — {"name":
//     "Alice"} in a reply about people must not become a call to a tool named
//     Alice. Unknown names render back as text, exactly as the model wrote them.
//
//   * Repair before rejecting. Models emit nearly-right JSON: trailing commas,
//     single quotes, True/None, smart quotes, double-encoded arguments. Each is
//     mechanically recoverable.

import { randomUUID } from "node:crypto";

export function normalizeName(s) {
  return String(s)
    .trim()
    .replace(/^(?:functions?|tools?)[.:]/i, "") // strip namespace prefix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function buildRegistry(tools) {
  const names = [];
  const byNorm = new Map();
  const schemas = new Map();
  for (const t of tools || []) {
    const n = t?.function?.name;
    if (!n || typeof n !== "string") continue;
    names.push(n);
    byNorm.set(normalizeName(n), n);
    schemas.set(n, t.function?.parameters || { type: "object", properties: {} });
  }
  return { names, byNorm, schemas, permissive: names.length === 0 };
}

/** Index just past the object starting at `start`, or -1 if it never closes.
    String- and escape-aware, so braces inside string values don't fool it. */
export function scanObject(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Progressively repair the near-JSON models actually emit. */
export function repairJson(src) {
  const attempts = [];
  let s = String(src ?? "").trim();
  attempts.push(s);

  // Smart quotes — usually picked up when the model formats as prose.
  s = s.replace(/[\u201C\u201D\u201E]/g, '"').replace(/[\u2018\u2019]/g, "'");
  attempts.push(s);

  // Python-flavoured literals, only as standalone tokens.
  s = s.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
  attempts.push(s);

  // Trailing commas before a closer.
  s = s.replace(/,\s*([}\]])/g, "$1");
  attempts.push(s);

  // Single-quoted keys/values -> double-quoted (most invasive, tried last).
  s = s.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner) => `"${inner.replace(/"/g, '\\"')}"`);
  attempts.push(s);

  // Literal newlines inside strings.
  s = s.replace(/"((?:[^"\\]|\\.)*)"/g, (m) => (m.includes("\n") ? m.replace(/\n/g, "\\n") : m));
  attempts.push(s);

  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch { /* next repair */ }
  }
  return null;
}

/** Every top-level JSON object in `s`, in order. */
export function objectsIn(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("{", i);
    if (open === -1) break;
    const end = scanObject(s, open);
    if (end === -1) {
      // Unterminated tail — the stream was cut off. Try to repair what's there.
      const obj = repairJson(s.slice(open));
      if (obj) out.push(obj);
      break;
    }
    const obj = repairJson(s.slice(open, end));
    if (obj) out.push(obj);
    i = end;
  }
  return out;
}

function coerceValue(v, schema) {
  if (!schema || v == null) return v;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (type === "number" || type === "integer") {
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) {
      const n = Number(v);
      return type === "integer" ? Math.trunc(n) : n;
    }
    return v;
  }
  if (type === "boolean") {
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (t === "true" || t === "yes" || t === "1") return true;
      if (t === "false" || t === "no" || t === "0") return false;
    }
    return v;
  }
  if (type === "array") {
    let arr = v;
    if (typeof arr === "string") {
      const parsed = repairJson(arr);
      arr = Array.isArray(parsed) ? parsed : [arr]; // lone scalar -> 1-element list
    } else if (!Array.isArray(arr)) {
      arr = [arr];
    }
    return schema.items ? arr.map((x) => coerceValue(x, schema.items)) : arr;
  }
  if (type === "object") {
    let obj = v;
    if (typeof obj === "string") {
      const parsed = repairJson(obj);
      if (parsed && typeof parsed === "object") obj = parsed;
    }
    if (obj && typeof obj === "object" && schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in obj) obj[k] = coerceValue(obj[k], sub);
      }
    }
    return obj;
  }
  if (type === "string" && typeof v !== "string" && typeof v !== "object") return String(v);
  return v;
}

function coerceArgs(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  if (!schema?.properties) return args;
  for (const [k, sub] of Object.entries(schema.properties)) {
    if (k in args) args[k] = coerceArgsKey(args, k, sub);
  }
  return args;
}
function coerceArgsKey(args, k, sub) {
  args[k] = coerceValue(args[k], sub);
  return args[k];
}

/** Build a validated call from one parsed object, or null if it isn't one.
    null is the safe answer: caller renders the text verbatim instead. */
function callFrom(obj, reg) {
  if (!obj || typeof obj !== "object") return null;

  // OpenAI's own wire shape, in case the model mirrors it back.
  const fn = obj.function && typeof obj.function === "object" ? obj.function : null;
  const rawName =
    fn?.name ?? obj.name ?? obj.tool_name ?? obj.tool ??
    (typeof obj.function === "string" ? obj.function : null);
  if (!rawName || typeof rawName !== "string") return null;

  // The registry is the gate: unknown name -> not a tool call.
  const name = reg.byNorm.get(normalizeName(rawName)) ?? (reg.permissive ? rawName.trim() : undefined);
  if (!name) return null;

  let args = fn?.arguments ?? obj.arguments ?? obj.parameters ?? obj.args ?? obj.input;

  // Double-encoded: "arguments": "{\"city\":\"Paris\"}"
  if (typeof args === "string") {
    const parsed = repairJson(args);
    args = parsed && typeof parsed === "object" ? parsed : {};
  }

  // Hoisted: {"name":"get_weather","city":"Paris"} — only trust keys the
  // schema actually declares, so stray prose fields can't leak into the call.
  if (!args || typeof args !== "object") {
    const props = reg.schemas.get(name)?.properties || {};
    const picked = {};
    for (const k of Object.keys(props)) if (k in obj) picked[k] = obj[k];
    args = picked;
  }

  const coerced = coerceArgs(args, reg.schemas.get(name));
  return { name, arguments: JSON.stringify(coerced ?? {}) };
}

/** All valid calls in a <tool_call> body (models sometimes pack in two). */
function callsInBlock(body, reg) {
  const out = [];
  for (const obj of objectsIn(body)) {
    if (Array.isArray(obj?.tool_calls)) {
      for (const item of obj.tool_calls) {
        const c = callFrom(item, reg);
        if (c) out.push(c);
      }
      continue;
    }
    const c = callFrom(obj, reg);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Apply the caller's tool options to what the model actually produced:
 *   tool_choice: {function:{name}}   only that tool may come back
 *   parallel_tool_calls: false       at most one call per turn
 */
export function applyToolPolicy(calls, body, reg) {
  let out = calls;

  const forced = body?.tool_choice && typeof body.tool_choice === "object"
    ? body.tool_choice?.function?.name
    : null;
  if (forced) {
    const canonical = reg.byNorm.get(normalizeName(forced)) ?? forced;
    out = out.filter((c) => c.name === canonical);
  }
  if (body?.parallel_tool_calls === false && out.length > 1) out = out.slice(0, 1);
  return out;
}

/**
 * Extract tool calls from a <tool_call> block's contents.
 * Returns [{ name, arguments }] with `arguments` as a JSON string — the shape
 * the proxy's existing OpenAI mapping expects.
 */
export function extractToolCalls(blockBody, tools) {
  if (!blockBody || typeof blockBody !== "string") return [];
  const reg = buildRegistry(tools);
  return callsInBlock(blockBody, reg);
}

/**
 * Every prefix of an opening tool tag, longest first.
 *
 * A tag split across two SSE frames must be held, not emitted: the streaming
 * loop checks whether the buffer ENDS with one of these and waits for the rest.
 * The list was hand-written and skipped "<tool_c" through "<tool_cal", so a
 * frame boundary inside the tag leaked the fragment as text AND left the block
 * unrecognized, sending the whole tool call to the client as prose (2026-08-25).
 * Shared with the tests so the two can't drift.
 */
export const PARTIAL_TOOL_TAGS = [
  "<tool_calls>", "<tool_call>", "<tool_calls", "<tool_call", "<tool_cal",
  "<tool_ca", "<tool_c", "<tool_", "<tool", "<too", "<to", "<t", "<",
];

/** True when the buffer's tail could still grow into an opening tool tag. */
export function endsWithPartialToolTag(buffer) {
  return PARTIAL_TOOL_TAGS.some((tag) => buffer.endsWith(tag));
}

/**
 * What to emit for whatever is still sitting in the streaming tool buffer when
 * the turn ends.
 *
 * A block the model never closed is the third blank-turn path (found live
 * 2026-08-25): it ended the call with `</parameter></function>` instead of
 * `</tool_call>`, so the close regex never matched, `inToolCall` stayed true,
 * and every later piece was withheld waiting for a tag that never came. The old
 * flush was gated on `!inToolCall` and skipped it — zero bytes to the client
 * with finish_reason "stop", and no retry either, because the empty-completion
 * guard sees a non-empty buffer and stays asleep.
 *
 * Unparseable tool XML is prose, same as the closed-block case: hand it back
 * verbatim, opening tag included.
 */
export function leftoverText(toolBuffer, inToolCall, openToolTag = "<tool_call>") {
  if (!toolBuffer) return "";
  return inToolCall ? openToolTag + toolBuffer : toolBuffer;
}

/**
 * Which generation in an SSE body is the answer.
 *
 * Qwen sometimes multiplexes two generations of the SAME turn into one response
 * body, interleaved frame by frame under different `response_id`s. Observed
 * 2026-08-24 on a 200 event-stream: 748 chars complete + 517 chars cut off
 * mid-JSON, each with its own `status:"finished"` frame. Reading the body as one
 * stream duplicates and truncates tool calls.
 *
 * Scores answer-phase text per response_id: balanced <tool_call> tags first
 * (a truncated twin is the one missing its closing tag), then length. Returns
 * null when there is nothing to choose between — the normal single-generation
 * case, where the caller must not filter anything.
 */
export function pickGeneration(events) {
  const text = new Map();
  for (const evt of events) {
    const rid = evt?.response_id;
    const delta = evt?.choices?.[0]?.delta;
    if (!rid || !delta) continue;
    if (delta.phase && delta.phase !== "answer") continue; // thinking is not the answer
    text.set(rid, (text.get(rid) || "") + (delta.content || ""));
  }
  const candidates = [...text].filter(([, t]) => t.length > 0);
  if (candidates.length < 2) return null;
  const score = (t) => {
    const open = (t.match(/<tool_call>/g) || []).length;
    const close = (t.match(/<\/tool_call>/g) || []).length;
    return [open === close ? 1 : 0, t.length];
  };
  let best = null;
  let bestScore = [-1, -1];
  for (const [rid, t] of candidates) {
    const s = score(t);
    if (s[0] > bestScore[0] || (s[0] === bestScore[0] && s[1] > bestScore[1])) {
      best = rid;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Harvest tool calls off Qwen's NATIVE `delta.function_call` channel.
 *
 * Qwen streams tool calls two ways: our prompt-emulated <tool_call> XML inside
 * `delta.content`, and its own structured `delta.function_call`. We only ever
 * read the first, so a native call vanished and the sole trace was the upstream
 * executor's "Tool <name> does not exists." rejection — which is emitted
 * *after* a complete call already crossed the wire (capture: 40 fc frames, then
 * the rejection).
 *
 * `function_call.arguments` uses SNAPSHOT semantics: every frame carries the
 * full arguments-so-far, not an OpenAI-style incremental fragment. Measured on
 * sse_todowrite.jsonl — last snapshot = 500 chars and parses; concat of all 40
 * = 10810 chars and does not. Accumulate by OVERWRITE, never `+=`.
 *
 * Output is synthesized back into <tool_call> XML so the whole hardened
 * pipeline (registry gate -> repairJson -> schema coercion -> applyToolPolicy)
 * applies unchanged, on both the streaming and non-streaming routes.
 */
const INTERNAL_PLUGINS = new Set([
  "image_edit",
  "image_gen",
  "t2i",
  "i2i",
  "code_interpreter",
  "doc_analysis",
]);

export function makeFCHarvester() {
  let pending = null;
  const done = new Set();
  const knows = (n) => !!n && (pending?.name === n || done.has(n));

  const flush = () => {
    if (!pending?.name || INTERNAL_PLUGINS.has(pending.name)) {
      pending = null;
      return "";
    }
    const { name, arguments: a } = pending;
    pending = null;
    done.add(name);
    const args = typeof a === "string" ? (a.trim() || "{}") : JSON.stringify(a ?? {});
    return `\n<tool_call>\n{"name": ${JSON.stringify(name)}, "arguments": ${args}}\n</tool_call>`;
  };

  return {
    flush,
    // Returns text to emit ("" until a call actually completes). A name change
    // ends the previous call — snapshots never rename, so without this a second
    // call in one stream would silently destroy the first.
    take(delta) {
      const fc = delta.function_call;
      if (!fc) return "";
      if (fc.name && INTERNAL_PLUGINS.has(fc.name)) return "";
      const out = pending?.name && fc.name && fc.name !== pending.name ? flush() : "";
      pending = fc;
      return out;
    },
    // The upstream executor rejects names it does not own. Swallow that canned
    // text ONLY for a call we already hold — otherwise it is a real failure
    // signal and must reach the client.
    suppressed(delta) {
      if (delta.role !== "function") return false;
      const m = String(delta.content || "").trim().match(/^Tool (.+?) does not exists?\.?$/);
      if (!m || !(knows(delta.name) || knows(m[1]))) return false;
      // Observability only — never echo this into the model's output channel:
      // a text delta would be replayed as history on the next turn.
      console.warn(`[toolparse] suppressed upstream rejection for declared tool '${m[1]}'`);
      return true;
    },
  };
}
