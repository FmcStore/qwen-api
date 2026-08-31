// Video-task helpers for the Wan engine.
//
// Lives outside server.js so the parsing is unit-testable (importing server.js
// starts the listener). Shapes here were cross-checked against two independent
// Qwen2API reimplementations, which converge on the same task-id patterns and
// the same in-chat markup — see README "Reference proxies".

// Renders routinely run past 3 minutes upstream; the reference proxies budget 20.
export const VIDEO_POLL_MAX = Number(process.env.QWEN_VIDEO_POLL_MAX || 60);
export const VIDEO_POLL_MS = Number(process.env.QWEN_VIDEO_POLL_MS || 20000);

export const VIDEO_URL_RE = /(https?:\/\/[^\s"<>]+\.(?:mp4|webm|mov|m3u8)[^\s"<>]*)/;

// `wan3.0-video` and friends are proxy-side ids, not upstream models: chat.qwen.ai
// drives the Wan engine from a normal chat model with chat_type t2v/i2v. The
// `-video` suffix convention is what both reference proxies use to route a chat
// turn to video, and it is what /v1/models advertises.
export const VIDEO_UPSTREAM_MODEL = "qwen3.8-max";

export function isVideoModel(model) {
  return /-video$/.test(String(model || ""));
}

// A render needs non-streaming JSON handling and must skip the direct transport.
// i2v (set whenever reference images are attached) needs exactly the same
// treatment as t2v — the call sites used to test t2v alone, so an image-to-video
// request was silently streamed down the wrong path.
export function isVideoChat(qwenMessages) {
  const type = qwenMessages?.[0]?.chat_type;
  return type === "t2v" || type === "i2v";
}

// Upstream is inconsistent about where the async task id lands: extra.wanx.task_id,
// output.task_id, a bare task_id/taskId, or an `id` sitting next to a task_status.
// The regexes cover raw SSE frames that never parse as JSON.
const TASK_ID_PATTERNS = [
  /"task_?[Ii]d"\s*:\s*"([^"]+)"/g,
  /task_?[Ii]d\s*[:=]\s*["']?([a-zA-Z0-9._-]+)["']?/g,
  /"id"\s*:\s*"([^"]+)"[\s\S]{0,120}"task_status"/g,
];

// Returns every plausible task id, most-structured first. Upstream can report
// several for one render and only one of them resolves, so callers poll all.
export function extractVideoTaskIds(raw) {
  const out = [];
  const push = (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !out.includes(s)) out.push(s);
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach(walk);
    push(node.task_id);
    push(node.taskId);
    const status = typeof node.status === "string" ? node.status.toLowerCase() : "";
    if (node.task_status || status === "pending" || status === "running") push(node.id);
    for (const v of Object.values(node)) walk(v);
  };
  try { walk(JSON.parse(raw)); } catch {}
  for (const re of TASK_ID_PATTERNS) {
    for (const m of String(raw ?? "").matchAll(re)) push(m[1]);
  }
  return out;
}

// The shape both reference proxies emit and parse back, so clients that already
// speak Qwen2API render it natively — except they put the URL as the element's
// *text*, which is `<video>` fallback content and never displayed by a browser
// that can play video. Clients that render the HTML (opencode's desktop UI) drew
// an empty 0:00 player. The URL belongs in `src`.
//
// `&` must be escaped: a signed CDN URL like `?key=x&copy=1` is otherwise parsed
// as a named character reference and the src silently loses characters.
const attrEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function buildVideoContent(url) {
  // Fallback <a> inside <video> is only shown when the player can't render
  // (HTML5 spec: content between <video> tags is native fallback content).
  return `\n<video controls="controls" src="${attrEscape(url)}"><a href="${attrEscape(url)}">Download Video</a></video>\n`;
}

// Virtual tool: injected into the schema block the model sees AND into the
// registry parseToolCallBlocks validates against, then intercepted proxy-side so
// the client never sees the call. Only offered to clients that already declared
// tools — the native-plugin kill flags are set in that case, so adding it costs a
// plain chat nothing.
export const VIDEO_TOOL_NAME = "generate_video";

export const VIDEO_TOOL = {
  type: "function",
  function: {
    name: VIDEO_TOOL_NAME,
    description: "Generate a video with the native Qwen Wan engine. Text-to-video, or image-to-video when an image is supplied. Runs on this server; the result is a video URL.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What the video shows: subject, motion, and camera movement.",
        },
        image: {
          type: "string",
          description: "Optional http(s) or data URL of a reference image to animate (image-to-video).",
        },
      },
      required: ["prompt"],
    },
  },
};

export function toolName(t) {
  return t?.function?.name || t?.name || "";
}
