// Anthropic Messages API <-> OpenAI Chat Completions translation.
// Inbound: request shape (messages, tools, tool_choice, system, stop_sequences).
// Outbound: AnthropicStreamEncoder (SSE) + buildAnthropicResponse (non-streaming),
// both tool-call aware (tool_use blocks, input_json_delta, stop_reason mapping).

export function estimateTokens(text) {
  // ponytail: chars/3 heuristic (good for CJK/code mix) — no tokenizer dependency; upgrade path: real tokenizer
  return Math.max(1, Math.round(String(text ?? "").length / 3));
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // ponytail: image blocks inside tool_result are dropped — Qwen upload path only handles user-turn parts
    return content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
  }
  return "";
}

export function translateAnthropicToOpenAI(body) {
  const out = { ...body };
  const messages = [];

  if (body.system) {
    const sysText = Array.isArray(body.system)
      ? body.system.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n\n")
      : body.system;
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  // tool_use id -> name, so tool_result can carry the tool name into <tool_response name="...">
  const toolNamesById = new Map();

  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) {
      messages.push(m);
      continue;
    }

    let current = null; // message being built for m.role (text + images + tool_calls)
    const flush = () => {
      if (!current) return;
      if (current.parts.length > 0 || current.toolCalls.length > 0) {
        const content = current.parts.length === 1 && current.parts[0].type === "text"
          ? current.parts[0].text
          : current.parts.length > 0 ? current.parts : (current.toolCalls.length ? null : "");
        const msg = { role: m.role, content };
        if (current.toolCalls.length > 0) msg.tool_calls = current.toolCalls;
        messages.push(msg);
      }
      current = null;
    };
    const ensure = () => {
      if (!current) current = { parts: [], toolCalls: [] };
    };

    for (const block of m.content) {
      if (!block) continue;
      if (block.type === "text") {
        ensure();
        current.parts.push({ type: "text", text: block.text || "" });
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        // stripped: Qwen side regenerates its own reasoning
      } else if (block.type === "tool_use") {
        ensure();
        if (block.name) toolNamesById.set(block.id, block.name);
        current.toolCalls.push({
          id: block.id || "call_" + Math.random().toString(36).slice(2, 11),
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === "tool_result") {
        flush(); // tool results must be standalone `role:"tool"` messages, not merged into the turn text
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          name: toolNamesById.get(block.tool_use_id) || undefined,
          content: toolResultText(block.content),
        });
      } else if (block.type === "image" && block.source) {
        ensure();
        const url = block.source.type === "url"
          ? block.source.url
          : `data:${block.source.media_type};base64,${block.source.data}`;
        current.parts.push({ type: "image_url", image_url: { url } });
      } else if (block.type === "document" && block.source) {
        ensure();
        const url = block.source.type === "url"
          ? block.source.url
          : `data:${block.source.media_type};base64,${block.source.data}`;
        current.parts.push({ type: "file_url", file_url: { url } });
      }
    }
    flush();
  }

  out.messages = messages;

  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) =>
      t?.input_schema
        ? { type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema } }
        : t
    );
  }

  if (body.tool_choice) {
    if (body.tool_choice.type === "auto") out.tool_choice = "auto";
    else if (body.tool_choice.type === "any") out.tool_choice = "required";
    else if (body.tool_choice.type === "tool")
      out.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
  }

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences;
  }

  return out;
}

// Converts OpenAI-style stream deltas ({content} / {tool_calls}) into Anthropic SSE events.
// Text and tool_use blocks are opened lazily; block indexes stay sequential per spec.
export class AnthropicStreamEncoder {
  constructor(res, model, id, { inputTokens = 0 } = {}) {
    this.res = res;
    this.blockIndex = -1;
    this.textOpen = false;
    this.emittedBlocks = 0;
    this.charCount = 0;
    this.#event("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, usage: { input_tokens: inputTokens } },
    });
  }

  #event(name, data) {
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  ping() {
    this.#event("ping", { type: "ping" });
  }

  #openText() {
    if (this.textOpen) return;
    this.blockIndex++;
    this.textOpen = true;
    this.#event("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "text", text: "" } });
  }

  #closeText() {
    if (!this.textOpen) return;
    this.textOpen = false;
    this.emittedBlocks++;
    this.#event("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
  }

  delta(d) {
    if (typeof d?.content === "string" && d.content) {
      this.#openText();
      this.charCount += d.content.length;
      this.#event("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "text_delta", text: d.content } });
    }
    if (Array.isArray(d?.tool_calls)) {
      this.#closeText();
      for (const tc of d.tool_calls) {
        if (!tc?.function?.name) continue; // skip empty follow-up deltas
        this.blockIndex++;
        this.emittedBlocks++;
        const args = (typeof tc.function.arguments === "string" && tc.function.arguments) || "{}";
        this.#event("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: { type: "tool_use", id: tc.id || "toolu_" + Math.random().toString(36).slice(2, 14), name: tc.function.name, input: {} },
        });
        this.charCount += args.length;
        this.#event("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "input_json_delta", partial_json: args } });
        this.#event("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
      }
    }
  }

  finish(openaiReason = "stop") {
    this.#closeText();
    if (this.emittedBlocks === 0) {
      this.#openText();
      this.#closeText();
    }
    this.#event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: openaiReason === "tool_calls" ? "tool_use" : "end_turn" },
      usage: { output_tokens: estimateTokens("x".repeat(this.charCount)) },
    });
    this.#event("message_stop", { type: "message_stop" });
  }
}

function safeParseArgs(args) {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

export function buildAnthropicResponse(reqModel, id, content, toolCalls = [], { inputTokens = 0 } = {}) {
  const blocks = [];
  if (content) blocks.push({ type: "text", text: content });
  let usageChars = (content || "").length;
  for (const tc of toolCalls) {
    blocks.push({
      type: "tool_use",
      id: tc.id || "toolu_" + Math.random().toString(36).slice(2, 14),
      name: tc.function.name,
      input: safeParseArgs(tc.function.arguments),
    });
    usageChars += typeof tc.function.arguments === "string" ? tc.function.arguments.length : 20;
  }
  return {
    id,
    type: "message",
    role: "assistant",
    model: reqModel,
    content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
    stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: estimateTokens("x".repeat(usageChars)) },
  };
}
