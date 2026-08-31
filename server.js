// OpenAI-compatible proxy for chat.qwen.ai
//
// Routes ALL requests through Puppeteer (real Chrome) to bypass Alibaba WAF.
// The browser has genuine TLS fingerprints and runs baxia.js natively.
//
// Endpoints:
//   GET    /v1/models                     -> lists available models
//   POST   /v1/chat/completions           -> OpenAI chat completions (streaming or not)
//   DELETE /v1/conversations/{id}         -> clear one conversation's memory
//   POST   /v1/conversations/{id}/reset   -> same, as a POST
//   GET    /health                        -> quick liveness check
//
// Memory: the proxy keeps its own role-tagged history per conversation (see
// store.js) and is authoritative. Each request runs in a throwaway Qwen chat that
// is created, used, then deleted — so your chat.qwen.ai sidebar stays clean while
// the model still "remembers" via the stored history.

import http from "node:http";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { Readable } from "node:stream";
import { Agent, setGlobalDispatcher } from "undici";

// Keep-alive agent: hold sockets open 60s between turns to eliminate
// the TLS handshake penalty on subsequent requests through WARP.
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 60_000,
  connections: 32,
  pipelining: 1,
}));
import { getHistory, saveHistory, clearConversation, MEMORY_FILE } from "./store.js";
import { initBrowser, browserFetch, browserFetchStream, closeBrowser } from "./browser.js";
import { fetchFileBytes, uploadFile } from "./upload.js";
import { buildDirectCookieHeader, rotateSsxmod, challengeMarker, directChallengeMarker } from "./ssxmod.js";
import { extractToolCalls, applyToolPolicy, buildRegistry, makeFCHarvester, pickGeneration, leftoverText, endsWithPartialToolTag, normalizeName } from "./toolparse.js";
import { extractVideoTaskIds, buildVideoContent, isVideoModel, isVideoChat, toolName, VIDEO_TOOL, VIDEO_TOOL_NAME, VIDEO_UPSTREAM_MODEL, VIDEO_POLL_MAX, VIDEO_POLL_MS, VIDEO_URL_RE } from "./video.js";
import { SEARCH_TOOL, SEARCH_TOOL_NAME, searchQueryOf, buildSearchContent } from "./websearch.js";
import {
  translateAnthropicToOpenAI,
  AnthropicStreamEncoder,
  estimateTokens,
  buildAnthropicResponse
} from "./anthropic.js";
import { extractQwenImageUrls } from "./artifacts.js";
import { buildImageConfig, normalizeAspectRatio, extractPromptRatio, parseImageCommand, isImageModel, IMAGE_TOOL, IMAGE_EDIT_TOOL, IMAGE_TOOL_NAME, IMAGE_EDIT_TOOL_NAME } from "./image.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QWEN_BASE = "https://chat.qwen.ai";
const DEFAULT_MODEL = "qwen3.8-max";

// Track async video generation jobs. Sweep on insert rather than a per-job
// timer: a job that finishes in 20s shouldn't hold a 30-minute timer open, and
// the map is only ever written here.
const videoJobs = new Map();
const VIDEO_JOB_TTL_MS = 30 * 60 * 1000;

function trackVideoJob(ticket, job) {
  const now = Date.now();
  for (const [key, entry] of videoJobs) {
    if (now - (entry.createdAt || 0) > VIDEO_JOB_TTL_MS) videoJobs.delete(key);
  }
  // startTime drives the fake progress bar and gets reset per attempt; createdAt
  // is when the ticket was issued and is what the TTL measures.
  videoJobs.set(ticket, { ...job, createdAt: videoJobs.get(ticket)?.createdAt || now });
}

// ---------------------------------------------------------------------------
// Resumable threads: conversationId -> live Qwen chat + last response_id.
//
// Qwen keeps the thread server-side: quote the previous answer's response_id
// as parent_id on the next request and it walks its own copy of the
// conversation, so the new message can carry just its own turn instead of the
// whole transcript (system prompt, tool schemas and all). Verified against the
// live endpoint by UltraFEmotes/qwen3.8-api; the opening response.created SSE
// frame announces the response_id we quote back.
//
// A thread lives on exactly one pooled account, so a resumed turn must go to
// the SAME token or not at all — hence the pinned token in each entry.
// ---------------------------------------------------------------------------

const RESUME_TTL_MS = 60 * 60_000;
const RESUME_MAX = 500;
const resumeSessions = new Map(); // conversationId -> { chatId, responseId, model, token, at }

function getSession(convId, model) {
  const s = resumeSessions.get(convId);
  if (!s) return null;
  if (Date.now() - s.at > RESUME_TTL_MS) { resumeSessions.delete(convId); return null; }
  if (model && s.model !== model) return null;
  s.at = Date.now(); // refresh recency so an active thread isn't evicted under load
  return s;
}

function saveSession(convId, entry) {
  if (!convId || !entry?.chatId || !entry?.responseId) return;
  resumeSessions.set(convId, { ...entry, at: Date.now() });
  // Map preserves insertion order, so the front is the least recently stored.
  while (resumeSessions.size > RESUME_MAX) {
    const oldest = resumeSessions.keys().next().value;
    if (oldest === undefined) break;
    resumeSessions.delete(oldest);
  }
}

function forgetSession(convId) {
  if (convId) resumeSessions.delete(convId);
}

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

const PORT = Number(process.env.PORT || 8787);
// Loopback by default: the proxy answers with `Access-Control-Allow-Origin: *`
// and holds live account tokens, so it must not be reachable off-box unless
// that is asked for explicitly.
const HOST = process.env.QWEN_HOST || "127.0.0.1";

const QWEN_TOKENS_ENV = (process.env.QWEN_TOKENS || process.env.QWEN_TOKEN || "").split(",").map(t => t.trim()).filter(Boolean);
let tokenIndex = 0;
const tokenCache = { tokens: [], tokensMtime: 0, exhaustedMtime: 0, exhaustedSet: new Set(), active: null };

function getActiveTokens() {
  let changed = false;

  let statTokens = null;
  try {
    statTokens = fs.statSync("./farmer/output/tokens.txt");
  } catch (e) {}

  if (statTokens) {
    if (statTokens.mtimeMs !== tokenCache.tokensMtime) {
      tokenCache.tokensMtime = statTokens.mtimeMs;
      try {
        const rawTokens = fs.readFileSync("./farmer/output/tokens.txt", "utf-8");
        tokenCache.tokens = rawTokens.split("\n").map(t => t.trim()).filter(Boolean);
        changed = true;
      } catch (e) {}
    }
  } else {
    if (tokenCache.tokens.length === 0 && QWEN_TOKENS_ENV.length > 0) {
      tokenCache.tokens = [...QWEN_TOKENS_ENV];
      changed = true;
    }
  }

  let statExhausted = null;
  try {
    statExhausted = fs.statSync("./farmer/output/exhausted.txt");
  } catch (e) {}

  if (statExhausted) {
    if (statExhausted.mtimeMs !== tokenCache.exhaustedMtime) {
      tokenCache.exhaustedMtime = statExhausted.mtimeMs;
      const nextExhausted = new Set();
      try {
        const rawExhausted = fs.readFileSync("./farmer/output/exhausted.txt", "utf-8");
        rawExhausted.split("\n").forEach(t => {
          const trimmed = t.trim();
          if (trimmed) nextExhausted.add(trimmed);
        });
      } catch (e) {}
      tokenCache.exhaustedSet = nextExhausted;
      changed = true;
    }
  }

  if (changed || tokenCache.active === null) {
    tokenCache.active = tokenCache.tokens.filter(t => !tokenCache.exhaustedSet.has(t) && !isTokenExpired(t));
  }

  return tokenCache.active;
}

function getNextToken() {
  const active = getActiveTokens();
  if (active.length === 0) return "";
  const now = Date.now();
  let candidates = active.filter(t => (tokenPark.get(t) || 0) <= now);
  // Everything parked: rotate through the full pool anyway rather than fail —
  // a parked token is a hint, not a certainty.
  if (candidates.length === 0) candidates = active;
  const t = candidates[tokenIndex % candidates.length];
  tokenIndex++;
  return t;
}

// Qwen tokens are JWTs carrying an exp claim. A provably-expired token can be
// skipped without spending a network round-trip on it. Unreadable != expired:
// it still gets its chance upstream.
function isTokenExpired(token) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return typeof payload?.exp === "number" && payload.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

function flagTokenExhausted(token) {
  if (!token) return;
  try {
    fs.mkdirSync("./farmer/output", { recursive: true });
    fs.appendFileSync("./farmer/output/exhausted.txt", token + "\n");
    tokenCache.exhaustedSet.add(token);
    tokenCache.active = null; // force re-filter
    console.log(`[qwen-proxy] Flagged token as exhausted: ${token.substring(0, 15)}...`);
  } catch (e) {
    console.error(`[qwen-proxy] Error flagging token: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Token parking: transient failures park a token out of rotation instead of
// permanently exhausting it. Classification by failure message shape:
//   quota-shaped  -> permanent exhaust (dead for the day)
//   expired JWT   -> permanent exhaust (dead forever)
//   WAF challenge -> park 5 min (often session/IP-sticky, recovers)
//   rate limit    -> park 60s (short throttle window)
// ---------------------------------------------------------------------------

const tokenPark = new Map(); // token -> parked-until epoch ms
const PARK_CHALLENGE_MS = 5 * 60_000;
const PARK_RATE_LIMIT_MS = 60_000;

function classifyFailure(message) {
  const msg = message || "";
  if (/access verification|captcha|FAIL_SYS_USER_VALIDATE|RGV587|baxia|punish/i.test(msg)) return "challenge";
  if (/upper limit|today's usage|usage limit|out of (?:quota|credits)|daily limit|exhausted/i.test(msg)) return "quota";
  if (/rate ?limit|too many requests|429|high demand|overloaded|temporarily unavailable/i.test(msg)) return "rate_limit";
  return null;
}

function parkToken(token, ms, kind) {
  if (!token) return;
  const until = Date.now() + ms;
  // Keep the longer of any existing park window.
  const prev = tokenPark.get(token) || 0;
  if (until > prev) tokenPark.set(token, until);
  console.log(`[qwen-proxy] Parked token ${token.substring(0, 15)}... for ${Math.round(ms / 1000)}s (${kind})`);
}

/**
 * Handle a failed token with the error that caused it. Permanent exhaust only
 * for provably-dead tokens; everything transient parks and comes back.
 */
function flagTokenFailed(token, message) {
  if (!token) return;
  const kind = classifyFailure(message);
  if (isTokenExpired(token)) {
    flagTokenExhausted(token);
    return;
  }
  if (kind === "quota") {
    flagTokenExhausted(token);
    return;
  }
  if (kind === "challenge") {
    parkToken(token, PARK_CHALLENGE_MS, "challenge");
    return;
  }
  if (kind === "rate_limit") {
    parkToken(token, PARK_RATE_LIMIT_MS, "rate_limit");
    return;
  }
  // Unknown failure that still looks usage-related: preserve the old
  // conservative behaviour and retire the token.
  if (/quota|rate|limit/i.test(message || "")) {
    flagTokenExhausted(token);
  }
}

const QWEN_COOKIES = process.env.QWEN_COOKIES || "";
const QWEN_CLIENT_VERSION = process.env.QWEN_CLIENT_VERSION || "0.2.83";
const QWEN_THINKING = /^(1|true|yes)$/i.test(process.env.QWEN_THINKING || "");
const QWEN_FORGET_MEMORIES = !/^(0|false|no)$/i.test(process.env.QWEN_FORGET_MEMORIES || "");
const QWEN_DEBUG_SSE_FILE = process.env.QWEN_DEBUG_SSE_FILE
  ? path.resolve(process.env.QWEN_DEBUG_SSE_FILE)
  : null;

if (getActiveTokens().length === 0) {
  console.warn(
    "[qwen-proxy] WARNING: No tokens available. Requests will fail.\n" +
      "  Run the token farmer or set QWEN_TOKENS in .env."
  );
}

// Build headers for API calls made inside the browser.
// These are passed to page.evaluate(fetch(url, {headers: ...})).
// The browser itself handles cookies and TLS — we just need the auth + app headers.
function qwenHeaders(extra = {}, tokenOverride = null) {
  const token = tokenOverride || getNextToken();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "X-Request-Id": randomUUID(),
    Version: QWEN_CLIENT_VERSION,
    source: "web",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Qwen API helpers (via browser)
// ---------------------------------------------------------------------------

// Create a fresh Qwen chat. Tries the direct path first (no browser), falls
// back to browser fetch on any direct failure.
async function createChat(model, token) {
  if (QWEN_DIRECT) {
    try {
      const id = await directCreateChat(model, token);
      return id;
    } catch (e) {
      console.warn(`[qwen-proxy] direct createChat failed (${e.message}) — using browser.`);
    }
  }
  await ensureBrowser();
  const result = await browserFetch(`${QWEN_BASE}/api/v2/chats/new`, {
    method: "POST",
    headers: qwenHeaders({}, token),
    body: JSON.stringify({
      title: "New Chat",
      models: [model || DEFAULT_MODEL],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
    }),
  });

  if (result.error) {
    const err = new Error(`Browser fetch failed: ${result.body || result.error}`);
    // Recycled-worker errors carry challenge=true so the retry loop re-runs on the fresh page
    if (result.challenge) err.challenge = true;
    throw err;
  }
  if (challengeMarker(result.status, result.body) !== null) {
    const err = new Error(
      "Qwen WAF challenge triggered on /chats/new. The browser session may need refreshing."
    );
    err.challenge = true;
    throw err;
  }

  let json;
  try {
    json = JSON.parse(result.body);
  } catch {
    throw new Error(`Unexpected /chats/new response (${result.status}): ${result.body.slice(0, 300)}`);
  }
  const id = json?.data?.id || json?.id || json?.data?.chat?.id;
  if (!id) throw new Error(`Could not find chat id: ${result.body.slice(0, 300)}`);
  return id;
}

// Delete a throwaway chat. Best-effort, never throws.
async function deleteChat(chatId, token) {
  if (!chatId) return;
  if (QWEN_DIRECT) {
    try {
      await directDeleteChat(chatId, token);
      return;
    } catch {}
  }
  try {
    await ensureBrowser();
    await browserFetch(`${QWEN_BASE}/api/v2/chats/${encodeURIComponent(chatId)}`, {
      method: "DELETE",
      headers: qwenHeaders({}, token),
    });
  } catch (e) {
    console.warn(`[qwen-proxy] could not delete temp chat ${chatId}: ${e.message}`);
  }
}

// Wipe Qwen's server-side saved memories. Best-effort.
async function forgetAllMemories(token) {
  if (!QWEN_FORGET_MEMORIES) return;
  if (QWEN_DIRECT) {
    try {
      await directForgetAllMemories(token);
      return;
    } catch {}
  }
  try {
    await ensureBrowser();
    await browserFetch(`${QWEN_BASE}/api/v2/memories/delete`, {
      method: "POST",
      headers: qwenHeaders({}, token),
      body: JSON.stringify({ forget_all: true }),
    });
  } catch (e) {
    console.warn(`[qwen-proxy] could not clear Qwen memories: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Lazy browser init
//
// With the direct-fetch path enabled, most traffic never needs Puppeteer.
// Chrome is therefore NOT launched at startup anymore — it boots on first
// fallback need (WAF challenge on the direct path). Set QWEN_DIRECT=0 to
// return to always-on browser mode.
// ---------------------------------------------------------------------------

let browserInitPromise = null;
function ensureBrowser() {
  if (!browserInitPromise) {
    console.log("[qwen-proxy] Browser needed — launching Chrome (fallback path)...");
    browserInitPromise = initBrowser(QWEN_COOKIES, getActiveTokens()).catch(e => {
      browserInitPromise = null; // allow retry on next need
      throw e;
    });
  }
  return browserInitPromise;
}

// ---------------------------------------------------------------------------
// Direct fetch path (no browser)
//
// Talks to chat.qwen.ai over plain node fetch with generated SSXMOD fingerprint
// cookies (ssxmod.js). Tried first for every call; on a WAF challenge (or any
// direct failure) the request falls back to the Puppeteer path. Set
// QWEN_DIRECT=0 to disable and always use the browser.
// ---------------------------------------------------------------------------

const QWEN_DIRECT = !/^(0|false|no|off)$/i.test(process.env.QWEN_DIRECT || "1");
const DIRECT_UA = process.env.QWEN_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function qwenDirectHeaders(token, extra = {}) {
  // ASCII-only timezone (non-ASCII parentheticals break some HTTP stacks).
  const timezone = new Date().toString().replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    Origin: QWEN_BASE,
    Referer: `${QWEN_BASE}/`,
    "User-Agent": DIRECT_UA,
    "X-Request-Id": randomUUID(),
    Version: QWEN_CLIENT_VERSION,
    source: "web",
    Timezone: timezone,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    Cookie: buildDirectCookieHeader(token),
    ...extra,
  };
}

function challengeError(message) {
  const err = new Error(message);
  err.challenge = true;
  return err;
}

/** True when a direct response is actually the WAF challenging us. */
// Create a fresh Qwen chat via direct fetch. Returns chat id.
async function directCreateChat(model, token) {
  // Body shape matches the live SPA / Syde client (not the older title form).
  const res = await fetch(`${QWEN_BASE}/api/v2/chats/new`, {
    method: "POST",
    headers: qwenDirectHeaders(token),
    body: JSON.stringify({
      chatId: "",
      models: [model || DEFAULT_MODEL],
      project_id: "",
      timestamp: Date.now(),
      chat_type: "t2t",
      chat_mode: "normal",
    }),
  });
  const text = await res.text();
  if (directChallengeMarker(res, text) !== null) {
    rotateSsxmod(); // mint a fresh fingerprint so the retry isn't stuck on the same pair
    throw challengeError(`WAF challenge on direct /chats/new (${res.status})`);
  }
  if (!res.ok) throw new Error(`direct /chats/new failed (${res.status}): ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`Unexpected direct /chats/new response: ${text.slice(0, 300)}`);
  }
  const id = json?.data?.id || json?.id || json?.data?.chat?.id;
  if (!id) throw new Error(`Could not find chat id in direct response: ${text.slice(0, 300)}`);
  return id;
}

// Delete a chat via direct fetch. Best-effort, never throws.
async function directDeleteChat(chatId, token) {
  if (!chatId) return;
  const res = await fetch(`${QWEN_BASE}/api/v2/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
    headers: qwenDirectHeaders(token),
  }).catch(() => null);
  if (res && directChallengeMarker(res, "") !== null) rotateSsxmod();
}

// Wipe Qwen's server-side memories via direct fetch. Best-effort.
async function directForgetAllMemories(token) {
  if (!QWEN_FORGET_MEMORIES) return;
  await fetch(`${QWEN_BASE}/api/v2/memories/delete`, {
    method: "POST",
    headers: qwenDirectHeaders(token),
    body: JSON.stringify({ forget_all: true }),
  }).catch(() => {});
}

/**
 * Run a completion over the direct path. Mirrors runCompletion's contract:
 * calls onDelta(piece, phase, rawJSON) per event, returns full answer text,
 * throws err.challenge when the WAF intervenes (caller falls back to browser).
 */
async function directRunCompletion(chatId, model, qwenMessages, token, onDelta, abortRef = null, parentId = null, statusRef = null) {
  const payload = buildCompletionPayload(chatId, model, qwenMessages, parentId);
  const isVideo = isVideoChat(qwenMessages);
  const url = `${QWEN_BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`;

  const ac = new AbortController();
  if (abortRef) abortRef.abort = async () => { try { ac.abort(); } catch {} };

  const res = await fetch(url, {
    method: "POST",
    headers: qwenDirectHeaders(token, {
      Accept: isVideo ? "application/json" : "text/event-stream",
      ...(isVideo ? {} : { "x-accel-buffering": "no" }),
    }),
    body: JSON.stringify(payload),
    signal: ac.signal,
  });

  if (isVideo) {
    let text;
    try {
      text = await res.text();
    } catch (e) {
      if (e.name === "AbortError") throw e;
      rotateSsxmod();
      throw challengeError(`direct completion read failed: ${e.message}`);
    }
    const marker = directChallengeMarker(res, text);
    if (marker) {
      rotateSsxmod();
      throw challengeError(`WAF challenge on direct completion (${res.status}, marker: ${marker})`);
    }
    if (!res.ok) throw new Error(`direct completion failed (${res.status}): ${text.slice(0, 200)}`);
    onDelta("", "event", text);
    return text;
  }

  if (!res.ok) {
    let text = "";
    try { text = await res.text(); } catch {}
    const marker = directChallengeMarker(res, text);
    if (marker) {
      rotateSsxmod();
      throw challengeError(`WAF challenge on direct completion (${res.status}, marker: ${marker})`);
    }
    throw new Error(`direct completion failed (${res.status}): ${text.slice(0, 200)}`);
  }

  // Incremental SSE streaming: stream frames live as chunks arrive from upstream.
  // Lock onto the first content-bearing response_id (matching browser path).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let answerRid = null;
  let sawAnswerFinished = false;
  const fc = makeFCHarvester();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete trailing fragment in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;

        if (QWEN_DEBUG_SSE_FILE) {
          try {
            fs.mkdirSync(path.dirname(QWEN_DEBUG_SSE_FILE), { recursive: true });
            fs.appendFileSync(QWEN_DEBUG_SSE_FILE, JSON.stringify({ chatId, phase: "direct", event: JSON.parse(data) }) + "\n");
          } catch {}
        }

        let evt;
        try { evt = JSON.parse(data); } catch { continue; }

        if (evt?.ret && Array.isArray(evt.ret) && evt.ret.includes("FAIL_SYS_USER_VALIDATE")) {
          reader.cancel().catch(() => {});
          rotateSsxmod();
          throw challengeError("WAF challenge mid-stream on direct completion");
        }
        if (evt?.error) {
          reader.cancel().catch(() => {});
          throw new Error(`Qwen stream error: ${evt.error.details || evt.error.code || "unknown"}`);
        }

        const delta = evt?.choices?.[0]?.delta;
        const piece = delta?.content || "";

        // Lock onto the first generation that carries content or a function call (browser path semantics)
        if (evt?.response_id && (piece || delta?.function_call)) {
          if (!answerRid) {
            answerRid = evt.response_id;
          } else if (evt.response_id !== answerRid) {
            continue; // losing generation's frames
          }
        } else if (answerRid && evt?.response_id && evt.response_id !== answerRid) {
          continue;
        }

        if (!delta) {
          onDelta("", "event", data);
          continue;
        }

        const phase = delta.phase;
        const harvest = fc.take(delta);
        if (harvest) {
          fullContent += harvest;
          onDelta(harvest, "answer", null);
        }
        if (fc.suppressed(delta)) continue;

        if (delta.status === "finished" && (!phase || phase === "answer")) {
          sawAnswerFinished = true;
          onDelta(piece || "", phase || "answer", data);
          continue;
        }
        if (piece) fullContent += piece;
        onDelta(piece, phase || "answer", data);
      }
    }

    if (buffer && buffer.trim().startsWith("data:")) {
      const data = buffer.trim().slice(5).trim();
      if (data && data !== "[DONE]") {
        try {
          const evt = JSON.parse(data);
          const delta = evt?.choices?.[0]?.delta;
          const piece = delta?.content || "";
          if (!answerRid || evt?.response_id === answerRid) {
            if (delta) {
              const harvest = fc.take(delta);
              if (harvest) {
                fullContent += harvest;
                onDelta(harvest, "answer", null);
              }
              if (!fc.suppressed(delta)) {
                if (piece) fullContent += piece;
                onDelta(piece, delta.phase || "answer", data);
              }
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name === "AbortError") throw e;
    rotateSsxmod();
    throw challengeError(`direct completion read failed: ${e.message}`);
  } finally {
    reader.cancel().catch(() => {});
  }

  // A call still pending when the stream ends is the common case: the rejection
  // frame and the finished frame both arrive while the last snapshot is held.
  const tail = fc.flush();
  if (tail) {
    fullContent += tail;
    onDelta(tail, "answer", null);
  }
  if (statusRef) statusRef.finished = sawAnswerFinished;
  return fullContent;
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

function normalizeRole(role) {
  return role === "assistant" ? "assistant" : role === "system" ? "system" : "user";
}

function messageText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content.map((p) => (typeof p === "string" ? p : p.text || "")).join("");
  return String(m.content ?? "");
}

function fileUrlsIn(m) {
  if (!Array.isArray(m.content)) return [];
  const urls = [];
  for (const part of m.content) {
    if (part) {
      if (part.type === "image_url") {
        const u = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (u) urls.push(u);
      } else if (part.type === "video_url") {
        const u = typeof part.video_url === "string" ? part.video_url : part.video_url?.url;
        if (u) urls.push(u);
      } else if (part.type === "audio_url") {
        const u = typeof part.audio_url === "string" ? part.audio_url : part.audio_url?.url;
        if (u) urls.push(u);
      } else if (part.type === "file_url") {
        const u = typeof part.file_url === "string" ? part.file_url : part.file_url?.url;
        if (u) urls.push(u);
      }
    }
  }
  return urls;
}

function buildQwenMessages(openaiMessages, model, files = [], mediaType = null, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const systemParts = [];
  const turns = [];

  if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
    const toolSchemas = JSON.stringify(options.tools);
    const toolPrompt = `# Tools\n\nYou have direct access to execution tools to interact with the local filesystem, workspace, and terminal.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n${toolSchemas}\n</tools>\n\nIMPORTANT: When asked to read, inspect, create, edit, search, or run commands on files or directories, you MUST call the appropriate tool (e.g. read, bash, grep, glob, edit) using <tool_call></tool_call> tags. Never claim you lack local file access—use the tools provided.\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>`;
    systemParts.push(toolPrompt);
    // The client IDE's own system prompt often lists third-party video plugins,
    // and the model parrots those instead of using what this proxy actually has.
    // Second half of this prompt is load-bearing: the tool runs proxy-side AFTER
    // the turn, and the native executor injects "Tool generate_video does not
    // exists" mid-turn. Without being told to ignore that, the model apologises
    // and falls back to a still image — which then ships alongside the video.
    if (options.tools.some((t) => toolName(t) === VIDEO_TOOL_NAME)) {
      systemParts.push(`You have a native video generation engine (Qwen Wan) reachable through the ${VIDEO_TOOL_NAME} tool, for both text-to-video and image-to-video. When asked whether you can generate or animate video, say yes and offer that tool. Never suggest installing third-party video tools or IDE plugins.

${VIDEO_TOOL_NAME} runs on the proxy, not upstream, and its result is appended to your reply after your turn ends. So: emit the ${VIDEO_TOOL_NAME} call, say at most one short line like "Rendering your video." and then stop. Any message claiming ${VIDEO_TOOL_NAME} does not exist or failed to load is spurious — ignore it. Never apologise for it, never claim the engine is unavailable, and never fall back to generating a still image instead.`);
    }
    // Same deal for search, and the model needs telling it exists: a tools-on
    // turn has Qwen's own search plugin killed off (feature_config below), so
    // without this it either answers a live question from stale memory or emits
    // a call against the plugin signature it remembers (`queries`, an array).
    if (options.tools.some((t) => toolName(t) === SEARCH_TOOL_NAME)) {
      systemParts.push(`You have live web search through the ${SEARCH_TOOL_NAME} tool. Use it whenever the answer depends on current information — prices, news, releases, today's date, anything that changed after your training data. Never tell the user to look it up themselves, and never answer a time-sensitive question from memory.

${SEARCH_TOOL_NAME} runs on the proxy, not upstream, and its result is appended to your reply after your turn ends. So: emit the ${SEARCH_TOOL_NAME} call with one plain "query" string, say at most one short line like "Searching the web." and then stop — do not guess the answer in the same turn. Any message claiming ${SEARCH_TOOL_NAME} does not exist is spurious — ignore it.`);
    }
    // Anthropic tool_choice any/forced-tool mapped here; OpenAI route benefits too
    const tc = options.tool_choice;
    if (tc === "required") {
      systemParts.push(`IMPORTANT: For this reply you MUST call one of the provided tools using the <tool_call> format. Do not answer with plain text only.`);
    } else if (tc?.type === "function" && tc.function?.name) {
      systemParts.push(`IMPORTANT: For this reply you MUST call the tool "${tc.function.name}" using the <tool_call> format. Do not answer with plain text only.`);
    }
  }

  // Tool-history budget.
  //
  // An agent's transcript is mostly TOOL RESULTS, and in a coding agent those
  // are file contents: twelve reads of a 4KB file already assemble a ~13.5k-
  // token prompt, and upstream latency scales with prompt size. The model does
  // not need file #1 in full on turn twelve — old results are replaced with a
  // stub that keeps the shape of the exchange while dropping the bytes. Recent
  // results stay verbatim; nothing is touched while the transcript is small.
  const TOOL_RESULT_CLAMP = Number(process.env.QWEN_TOOL_CLAMP || 8000);
  const TOOL_HISTORY_BUDGET = Number(process.env.QWEN_TOOL_BUDGET || 24000);
  const TOOL_KEEP_RECENT = 3;

  const toolIdx = [];
  openaiMessages.forEach((m, i) => { if (m?.role === "tool") toolIdx.push(i); });
  const bodyAt = new Map(); // msg index -> clamped body
  for (const i of toolIdx) {
    const raw = messageText(openaiMessages[i]);
    if (raw.length <= TOOL_RESULT_CLAMP) {
      bodyAt.set(i, raw);
    } else {
      const dropped = raw.length - TOOL_RESULT_CLAMP;
      // Keep the head: file contents are front-loaded. The marker tells the
      // model the rest exists rather than letting it assume the file ends there.
      bodyAt.set(i, raw.slice(0, TOOL_RESULT_CLAMP) + `\n… [${dropped} more bytes truncated]`);
    }
  }
  let toolTotal = [...bodyAt.values()].reduce((n, b) => n + b.length, 0);
  const elidedAt = new Map(); // msg index -> original byte count (stub replaces body)
  const elidable = toolIdx.slice(0, Math.max(0, toolIdx.length - TOOL_KEEP_RECENT));
  for (const i of elidable) {
    if (toolTotal <= TOOL_HISTORY_BUDGET) break;
    toolTotal -= bodyAt.get(i).length;
    elidedAt.set(i, bodyAt.get(i).length);
  }

  openaiMessages.forEach((m, mi) => {
    if (m.role === "system") {
      const text = messageText(m);
      if (text) systemParts.push(text);
    } else if (m.role === "tool") {
      if (!messageText(m)) return;
      // Tool results continue the exchange — they render as user turns IN
      // SEQUENCE so they sit right after the assistant <tool_call> that
      // triggered them. Hoisting them into the system block scrambles the
      // order (result before call), which confuses the model — one observed
      // "Tool edit does not exists." instance tracked to this. NOTE: the
      // same error string is also produced by Qwen's native function-calling
      // layer intercepting emulated calls (see feature_config above); two
      // causes, one symptom. Ordering was wrong regardless, so this stays.
      if (elidedAt.has(mi)) {
        // Self-closing: there is no body, and the model should not wait for one.
        turns.push({ role: "user", text: `<tool_response name="${m.name || 'tool'}" elided="${elidedAt.get(mi)} bytes" />` });
      } else {
        turns.push({ role: "user", text: `<tool_response name="${m.name || 'tool'}">\n${bodyAt.get(mi)}\n</tool_response>` });
      }
    } else {
      let text = messageText(m);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          text += `\n<tool_call>\n{"name": "${tc.function.name}", "arguments": ${typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)}}\n</tool_call>`;
        }
        text = text.trim();
      }
      if (text) turns.push({ role: m.role === "assistant" ? "assistant" : "user", text });
    }
  });

  // Simple context truncation: if total estimated tokens exceed QWEN_MAX_CONTEXT,
  // truncate oldest non-system turns while preserving system prompt & recent turns.
  const MAX_CONTEXT_TOKENS = Number(process.env.QWEN_MAX_CONTEXT || 60000);
  const estimatedTokens = (systemParts.join(" ").length + turns.reduce((acc, t) => acc + t.text.length, 0)) / 3.0;

  let effectiveTurns = turns;
  if (estimatedTokens > MAX_CONTEXT_TOKENS && turns.length > 6) {
    const keepLast = 6;
    const droppedCount = turns.length - keepLast;
    effectiveTurns = [
      { role: "user", text: `[Notice: ${droppedCount} earlier message(s) truncated — context limit reached]` },
      ...turns.slice(-keepLast)
    ];
    console.log(`[qwen-proxy] Context limit reached (~${Math.round(estimatedTokens)} tokens). Truncated ${droppedCount} turns.`);
  }

  let content;
  if (mediaType === "image" || isImageModel(model)) {
    const lastUserTurn = effectiveTurns.filter(t => t.role === "user").pop();
    content = lastUserTurn?.text ?? "";
  } else if (systemParts.length === 0 && effectiveTurns.length <= 1) {
    content = effectiveTurns[0]?.text ?? "";
  } else {
    const lines = [];
    if (systemParts.length) lines.push(systemParts.join("\n\n"), "");
    for (const t of effectiveTurns) {
      lines.push(`${t.role === "assistant" ? "Assistant" : "User"}: ${t.text}`);
    }
    lines.push("Assistant:");
    content = lines.join("\n");
  }

  let chatType = "t2t";
  let subChatType = "t2t";
  const effort = String(options.reasoning_effort || options.thinking_mode || "").toLowerCase();
  const isFast = effort === "none" || effort === "low" || effort === "fast" || effort === "off";
  const isAuto = effort === "auto" || effort === "medium";
  const thinkingLabel = isFast ? "OFF (fast)" : (isAuto ? "AUTO" : "ON (thinking)");
  console.log(`[qwen-proxy] effort: reasoning_effort=${JSON.stringify(options.reasoning_effort ?? null)} -> thinking_${thinkingLabel}`);
  
  let featureConfig = {
    thinking_enabled: !isFast,
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: isAuto,
    thinking_mode: isFast ? "off" : (isAuto ? "auto" : "Thinking"),
    thinking_format: "summary",
    auto_search: !isFast
  };
  if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
    featureConfig.function_calling = false;
    featureConfig.plugins_enabled = false;
    featureConfig.code_interpreter = false;
    featureConfig.auto_search = false;
    featureConfig.enable_tools = false;
    featureConfig.enable_function_call = false;
    featureConfig.tool_choice = "none";
  }
  let extra = {
    meta: {
      subChatType: "t2t"
    }
  };

  if (mediaType === "image" || isImageModel(model)) {
    const img = buildImageConfig(files, options);
    chatType = img.chatType;
    subChatType = img.subChatType;
    featureConfig = img.featureConfig;
    extra = img.extra;
  } else if (mediaType === "video" || isVideoModel(model)) {
    const vType = files.length > 0 ? "i2v" : "t2v";
    chatType = vType;
    subChatType = vType;
    featureConfig = {
      thinking_enabled: false,
      output_schema: "phase",
      research_mode: "normal",
      auto_thinking: false,
      thinking_mode: "Fast",
      auto_search: true
    };
    extra = { meta: { subChatType: vType, size: "16:9" } };
  }

  return [
    {
      id: null,
      fid: randomUUID(),
      parentId: null,
      childrenIds: [],
      role: "user",
      content,
      user_action: "chat",
      files,
      timestamp: now,
      models: [model || DEFAULT_MODEL],
      model: "",
      chat_type: chatType,
      feature_config: featureConfig,
      extra: extra,
      sub_chat_type: subChatType,
      parent_id: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Completion via browser (non-streaming browser-side, parsed server-side)
// ---------------------------------------------------------------------------

// Build the /chat/completions request body (shared by direct + browser paths).
function buildCompletionPayload(chatId, model, qwenMessages, parentId = null) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model: model || DEFAULT_MODEL,
    parent_id: parentId || null,
    messages: qwenMessages,
    timestamp: now,
  };
  if (parentId && qwenMessages[0]) {
    qwenMessages[0] = { ...qwenMessages[0], parentId, parent_id: parentId };
  }

  const isVideo = isVideoChat(qwenMessages);
  if (isVideo) {
    payload.size = "16:9"; // Video UI defaults to 16:9
    payload.stream = false;
  } else {
    const firstMsg = qwenMessages[0];
    const explicitRatio = firstMsg?.extra?.meta?.size || firstMsg?.extra?.meta?.aspectRatio || firstMsg?.feature_config?.default_aspect_ratio;
    if ((firstMsg?.sub_chat_type === "t2i" || firstMsg?.chat_type === "t2i" || isImageModel(model)) && explicitRatio) {
      payload.size = explicitRatio;
    }
  }
  return payload;
}

// Run a completion through the browser. Uses browserFetchStream which bridges
// SSE chunks back to Node.js in real-time via page.exposeFunction.
// Calls onDelta(text, phase) for each token as it arrives from Qwen.
// Returns the full accumulated answer text.
// Optional abortRef gets an .abort() bound to this request's browser stream.
// Sentinel phase: "discard what you buffered, this turn is starting over".
const RESTART_PHASE = "__restart__";

async function runCompletion(chatId, model, qwenMessages, token, onDelta, abortRef = null, parentId = null, statusRef = null) {
  const isVideo = isVideoChat(qwenMessages);
  const payload = buildCompletionPayload(chatId, model, qwenMessages, parentId);

  if (process.env.QWEN_DEBUG) fs.writeFileSync("payload_dump.json", JSON.stringify(payload, null, 2));

  const url = `${QWEN_BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`;
  const headers = qwenHeaders({ Accept: isVideo ? "application/json" : "text/event-stream" }, token);

  // Direct path first: plain fetch with generated SSXMOD cookies. Falls back
  // to the browser below on WAF challenge or any other direct failure.
  if (!isVideo && QWEN_DIRECT) {
    const startedAt = Date.now();
    try {
      console.log(`[qwen-proxy] Sending completion request via direct fetch...`);
      return await directRunCompletion(chatId, model, qwenMessages, token, onDelta, abortRef, parentId, statusRef);
    } catch (e) {
      if (e.name === "AbortError") {
        // A client-side timeout is indistinguishable from an upstream fault at the
        // client, which badges it as a rate-limit/anti-bot banner and retries. The
        // elapsed time is the only thing that separates "client too impatient" from
        // "we really were stuck", so record it before rethrowing.
        console.warn(`[qwen-proxy] client hung up after ${Date.now() - startedAt}ms on the direct path — nothing to fall back for.`);
        throw e;
      }
      console.warn(`[qwen-proxy] direct completion failed (${e.message}) — falling back to browser.`);
      // The browser replays this turn from the top through the same onDelta, so
      // whatever the direct attempt already streamed has to be discarded. Its
      // last <tool_call> is usually half-written; concatenating attempt 2 onto
      // that fragment produces a malformed call the client silently drops.
      onDelta("", RESTART_PHASE, null);
      // Rebind a no-op abort so the browser path can install its own cleanly.
      if (abortRef) abortRef.abort = async () => {};
    }
  }

  console.log(`[qwen-proxy] Sending completion request via browser ${isVideo ? 'fetch' : 'stream'}...`);
  await ensureBrowser();

  let fullContent = "";

  let result;
  if (isVideo) {
    result = await browserFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    console.log("[qwen-proxy] completions returned:", result.body);
    if (process.env.QWEN_DEBUG) fs.writeFileSync("completions_response.json", result.body);
    if (result.ok) {
      fullContent = result.body;
    }
  } else {
    // Same native-channel harvest as the direct path. browser.js already ships
    // the whole event across (JSON.stringify(evt) -> rawJSON), so nothing in
    // page context needs to change.
    const fc = makeFCHarvester();
    // Live stream: no body to pre-scan, so lock onto the first generation that
    // says anything and ignore the rest (see pickGeneration for why there can
    // be more than one).
    let answerRid = null;
    result = await browserFetchStream(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, QWEN_THINKING, (piece, phase, rawJSON) => {
      if (QWEN_DEBUG_SSE_FILE && rawJSON) {
        try {
          fs.mkdirSync(path.dirname(QWEN_DEBUG_SSE_FILE), { recursive: true });
          fs.appendFileSync(QWEN_DEBUG_SSE_FILE, JSON.stringify({ chatId, phase, event: JSON.parse(rawJSON) }) + "\n");
        } catch (error) {
          console.warn(`[qwen-proxy] Could not capture SSE event: ${error.message}`);
        }
      }
      let delta = null;
      let evt = null;
      if (rawJSON) {
        try { evt = JSON.parse(rawJSON); delta = evt?.choices?.[0]?.delta || null; } catch {}
      }
      if (evt?.response_id && (piece || delta?.function_call)) {
        if (!answerRid) {
          answerRid = evt.response_id;
        } else if (evt.response_id !== answerRid) {
          return; // a second generation of the same turn — not ours
        }
      }
      if (delta) {
        const harvest = fc.take(delta);
        if (harvest) {
          fullContent += harvest;
          onDelta(harvest, "answer", null);
        }
        if (fc.suppressed(delta)) return;
      }
      if (piece) fullContent += piece;
      onDelta(piece, phase, rawJSON);
    }, abortRef);
    const tail = fc.flush();
    if (tail) {
      fullContent += tail;
      onDelta(tail, "answer", null);
    }
    // browserFetchStream reports whether the answer phase actually terminated.
    if (statusRef) statusRef.finished = result.finished === true;
  }

  if (result.challenge) {
    const err = new Error("Qwen WAF challenge triggered on completion and could not be solved.");
    err.challenge = true;
    throw err;
  }

  if (!result.ok) {
    throw new Error(`Qwen completion failed: ${result.error}`);
  }

  return fullContent;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP layer
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendError(res, status, message, type = "invalid_request_error") {
  sendJson(res, status, { error: { message, type } });
}

function collectImageUrls(target, value, excluded) {
  for (const url of extractQwenImageUrls(value, { exclude: excluded })) target.add(url);
}

// Cap on an inbound request body. Generous because chat bodies carry base64
// images, but unbounded accumulation is a one-curl OOM.
const MAX_BODY_BYTES = Number(process.env.QWEN_MAX_BODY_BYTES || 64 * 1024 * 1024);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      // Past the cap: keep draining so the socket doesn't stall, but stop
      // buffering. Destroying the request here would kill the response with it
      // and the client would see a reset instead of the 413.
      if (over) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        reject(Object.assign(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    // Concat before decoding: `data += chunk` decodes every chunk on its own and
    // mangles any UTF-8 sequence that straddles a chunk boundary — routine for
    // CJK prompts once a body spans more than one TCP segment.
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Throws rather than returning null: four of the five callers dereference the
// result immediately, so a null turned into a TypeError and a 500 "server_error"
// — which clients read as a retryable upstream fault and hammer four times over.
// statusCode rides the same channel readBody's 413 uses; the top-level catch maps it.
function parseJsonBody(req) {
  return readBody(req).then(raw => {
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(
        `[qwen-proxy] unparseable request body (${Buffer.byteLength(raw, "utf8")} bytes): ` +
        `${JSON.stringify(raw.slice(0, 200))}`
      );
      throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
    }
  });
}

function modelsPayload() {
  return {
    object: "list",
    data: [
      { id: "qwen3.8-max", object: "model", created: 0, owned_by: "qwen" },
      // Dropped from Qwen's /api/models catalog but still served upstream —
      // keep it reachable so existing client configs don't break.
      { id: "qwen3.8-max-preview", object: "model", created: 0, owned_by: "qwen" },
      { id: "qwen3.8-27b", object: "model", created: 0, owned_by: "qwen" },
      { id: "wan3.0-video", object: "model", created: 0, owned_by: "qwen" },
      { id: "qwen3.7-plus", object: "model", created: 0, owned_by: "qwen" },
      { id: "qwen-image-3.0-pro", object: "model", created: 0, owned_by: "qwen" },
      { id: "qwen-image-3.0", object: "model", created: 0, owned_by: "qwen" },
      { id: "qwen-image-edit", object: "model", created: 0, owned_by: "qwen" },
    ],
  };
}

// An explicit id means "keep my history for me". No id means the client is
// stateful (opencode, the Anthropic SDK) and resends its whole thread every
// turn — see buildEffectiveHistory.
function conversationIdFor(req, body) {
  return req.headers["x-conversation-id"] || body.conversation_id || body.user || null;
}

function buildEffectiveHistory(conversationId, incoming) {
  // No id: the client owns the thread. Hand its messages to buildQwenMessages
  // untouched.
  //
  // The store path below flattens every message through normalizeRole +
  // messageText, which drops `tool_calls` and `m.name` — so tool results lose
  // their <tool_response> wrapper and the tool-result clamp/elision above never
  // engages, and every file body gets re-sent in full on every turn. Worse, it
  // keyed idless clients under one shared "default" bucket and then replaced
  // their real thread with it, so two unrelated sessions merged: the model saw
  // the same task three times in one context and answered with repeated,
  // half-truncated <tool_call> blocks.
  if (!conversationId) return incoming;
  const history = getHistory(conversationId);
  if (history.length === 0) {
    for (const m of incoming) {
      const content = messageText(m);
      if (content) history.push({ role: normalizeRole(m.role), content });
    }
  } else {
    const last = incoming[incoming.length - 1];
    const content = messageText(last);
    if (content) history.push({ role: normalizeRole(last.role), content });
  }
  return history;
}

// ---------------------------------------------------------------------------
// Image & Video Generations
// ---------------------------------------------------------------------------

async function parseMultipartForm(req) {
  const contentType = req.headers["content-type"] || "";
  const webStream = Readable.toWeb(req);
  const response = new Response(webStream, {
    headers: { "content-type": contentType }
  });
  return await response.formData();
}

async function runImagePrompt(prompt, model = "qwen-image-3.0", files = [], options = {}) {
  const reqModel = isImageModel(model) || String(model || "").toLowerCase().startsWith("dall-e") ? "qwen3.8-max" : model;
  const qwenMsgs = buildQwenMessages([{ role: "user", content: prompt.trim() }], reqModel, files, "image", options);

  let content = "";
  const urlParts = [];
  const capturedImageUrls = new Set();
  let attempts = 0;

  while (attempts < 5) {
    let chatId;
    const reqToken = getNextToken();
    try {
      chatId = await createChat(reqModel, reqToken);
      if (attempts === 0) console.log(`[qwen-proxy] Created temp chat ${chatId} (image: ${reqModel})`);
    } catch (e) {
      if (e.challenge && attempts < 4) {
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }
      throw e;
    }

    try {
      content = await runCompletion(chatId, reqModel, qwenMsgs, reqToken, (piece, phase, rawJSON) => {
        if (rawJSON) {
          collectImageUrls(capturedImageUrls, rawJSON);
          try {
            const evt = JSON.parse(rawJSON);
            const delta = evt?.choices?.[0]?.delta;
            const parts = Array.isArray(delta?.content) ? delta.content : null;
            if (parts) {
              for (const u of fileUrlsIn({ content: parts })) urlParts.push(u);
            }
          } catch {}
        }
      });
      await deleteChat(chatId, reqToken);
      break;
    } catch (e) {
      await deleteChat(chatId, reqToken);
      if (e.challenge && attempts < 4) {
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }
      throw e;
    }
  }

  collectImageUrls(capturedImageUrls, content);
  let url = capturedImageUrls.values().next().value || urlParts[0] || null;
  if (!url) {
    let m1 = content.match(/"(?:url|image|src|imageUrl|image_url)"\s*:\s*"(https?:\/\/[^"]+)"/);
    if (m1) url = m1[1];
    else {
      let m2 = content.match(/!\[.*?\]\((https:\/\/[^)]+)\)/);
      if (m2) url = m2[1];
      else {
        let m3 = content.match(/(https?:\/\/(?:cdn\.qwenlm\.ai|wanx\.alicdn\.com|img\.alicdn\.com)[^\s"<>]*)/);
        if (m3) url = m3[1];
      }
    }
  }

  if (!url) throw new Error("Failed to extract image URL: " + content);
  return url;
}

async function handleImageGenerations(req, res) {
  try {
    const body = await parseJsonBody(req);
    const requestedModel = body.model || "qwen-image-3.0";
    const prompt = body.prompt || "";
    if (!prompt.trim()) {
      return sendError(res, 400, "Missing required prompt parameter", "invalid_request_error");
    }
    const ratio = body.aspect_ratio || body.size || body.aspectRatio || null;
    const url = await runImagePrompt(prompt, requestedModel, [], { aspect_ratio: ratio });
    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ url }]
    });
  } catch (err) {
    console.error("[qwen-proxy] handleImageGenerations error:", err);
    return sendError(res, err.challenge ? 503 : 500, err.message, err.challenge ? "upstream_challenge" : "server_error");
  }
}

async function handleImageEdits(req, res) {
  const contentType = req.headers["content-type"] || "";
  let prompt = "";
  let model = "qwen-image-3.0";
  let bytes = null;
  let mime = "image/png";
  let filename = null;
  let ratio = null;

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await parseMultipartForm(req);
      prompt = (formData.get("prompt") || "").toString();
      model = (formData.get("model") || "qwen-image-3.0").toString();
      ratio = formData.get("aspect_ratio") || formData.get("size") || formData.get("aspectRatio") || null;

      const file = formData.get("image") || formData.get("file");
      if (!file || typeof file === "string") {
        return sendError(res, 400, "Missing required image file in multipart form", "invalid_request_error");
      }

      bytes = Buffer.from(await file.arrayBuffer());
      mime = file.type || "image/png";
      filename = file.name || "image.png";
    } else {
      const body = await parseJsonBody(req);
      if (!body) {
        return sendError(res, 400, "Invalid JSON body", "invalid_request_error");
      }
      prompt = body.prompt || "";
      model = body.model || "qwen-image-3.0";
      ratio = body.aspect_ratio || body.size || body.aspectRatio || null;

      const imageRef = body.image || body.images;
      if (!imageRef) {
        return sendError(res, 400, "Missing required image parameter (URL or base64 data-URL)", "invalid_request_error");
      }

      const rawRef = Array.isArray(imageRef) ? imageRef[0] : imageRef;
      const refUrl = typeof rawRef === "string" ? rawRef : (rawRef?.url || rawRef?.image_url?.url);
      if (!refUrl) {
        return sendError(res, 400, "Invalid image parameter", "invalid_request_error");
      }

      const fetched = await fetchFileBytes(refUrl);
      bytes = fetched.bytes;
      mime = fetched.mime || "image/png";
    }

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return sendError(res, 400, "Missing required prompt parameter", "invalid_request_error");
    }

    const uploadToken = getNextToken();
    const uploadedFile = await uploadFile(
      () => qwenHeaders({}, uploadToken),
      QWEN_BASE,
      bytes,
      mime,
      filename
    );

    const url = await runImagePrompt(prompt, model, [uploadedFile], { aspect_ratio: ratio });
    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ url }]
    });
  } catch (err) {
    console.error("[qwen-proxy] handleImageEdits error:", err);
    return sendError(res, err.challenge ? 503 : 500, "Image edit failed: " + err.message, err.challenge ? "upstream_challenge" : "server_error");
  }
}

// Runs one video render to completion. Resolves to the media URL, throws on
// failure or timeout. Blocking by design: /v1/videos/generations calls it
// fire-and-forget behind a ticket, the chat route awaits it.
async function generateVideo({ prompt, files = [], model = VIDEO_UPSTREAM_MODEL }, abortRef = null) {
  const qwenMsgs = buildQwenMessages([{ role: "user", content: prompt }], model, files, "video");
  let attempts = 0;

  while (attempts < 5) {
    if (abortRef?.aborted) throw new Error("Video generation aborted by client");
    let chatId;
    const reqToken = getNextToken();
    try {
      chatId = await createChat(model, reqToken);
    } catch (e) {
      if (e.challenge && attempts < 4) {
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }
      if (e.message.match(/quota|rate|limit/i)) {
        console.warn(`[proxy] Rate limit on createChat: ${e.message}`);
        flagTokenFailed(reqToken, e.message);
        attempts++;
        continue;
      }
      throw e;
    }

    try {
      if (abortRef?.aborted) throw new Error("Video generation aborted by client");
      const result = await runCompletion(chatId, model, qwenMsgs, reqToken, () => {}, abortRef);
      if (result && result.match(/quota|rate|limit/i)) {
        console.warn(`[proxy] Rate limit on runCompletion: ${result}`);
        flagTokenFailed(reqToken, result);
        attempts++;
        continue;
      }
      const taskIds = extractVideoTaskIds(result);
      if (taskIds.length) console.log(`[proxy] Extracted video task id(s): ${taskIds.join(", ")}`);

      // Occasionally the URL is already in the completion response.
      const direct = result.match(VIDEO_URL_RE);
      if (direct) return direct[1];

      for (let pollCount = 0; pollCount < VIDEO_POLL_MAX; pollCount++) {
        if (abortRef?.aborted) throw new Error("Video generation aborted by client");
        await new Promise(r => setTimeout(r, VIDEO_POLL_MS));
        if (abortRef?.aborted) throw new Error("Video generation aborted by client");

        // 1. Verified wan task polling. Upstream can report several candidate ids
        //    for one render and only one of them resolves, so try each.
        for (const taskId of taskIds) {
          if (abortRef?.aborted) throw new Error("Video generation aborted by client");
          // Qwen moved task status from v2 to v1; the old path 404s.
          const taskUrl = `${QWEN_BASE}/api/v1/tasks/status/${encodeURIComponent(taskId)}`;
          await ensureBrowser();
          const taskRes = await browserFetch(taskUrl, {
            method: "GET",
            headers: qwenHeaders({}, reqToken)
          });
          if (!taskRes.ok) continue;
          const match = taskRes.body.match(VIDEO_URL_RE);
          if (match) return match[1];
        }

        // 2. Fallback to scraping the chat history memory
        if (abortRef?.aborted) throw new Error("Video generation aborted by client");
        const memoryUrl = `${QWEN_BASE}/api/v2/chats/${encodeURIComponent(chatId)}`;
        await ensureBrowser();
        const memoryRes = await browserFetch(memoryUrl, {
          method: "GET",
          headers: qwenHeaders({}, reqToken)
        });
        if (memoryRes.ok) {
          const m = memoryRes.body.match(VIDEO_URL_RE);
          if (m) return m[1];
        }
      }

      const budgetMin = Math.round((VIDEO_POLL_MAX * VIDEO_POLL_MS) / 60000);
      throw new Error(`Timed out waiting for video generation to complete (${budgetMin} minutes).`);
    } finally {
      try { await deleteChat(chatId, reqToken); } catch {}
    }
  }

  throw new Error("Video generation failed: upstream rate-limited or challenged 5 times.");
}

// Uploads any reference image(s) on a /v1/videos/generations body. Their presence
// is what switches the render from t2v to i2v.
async function uploadVideoRefs(body) {
  const refs = [];
  const pushRef = (u) => {
    if (typeof u === "string" && u.trim()) refs.push(u.trim());
    else if (typeof u?.url === "string") refs.push(u.url);
    else if (typeof u?.image_url?.url === "string") refs.push(u.image_url.url);
  };
  if (body.image) Array.isArray(body.image) ? body.image.forEach(pushRef) : pushRef(body.image);
  if (body.images) Array.isArray(body.images) ? body.images.forEach(pushRef) : pushRef(body.images);

  const files = [];
  const uploadToken = getNextToken();
  for (const u of refs.slice(0, 4)) { // upstream realistically uses one; cap for safety
    const { bytes, mime } = await fetchFileBytes(u);
    files.push(await uploadFile(() => qwenHeaders({}, uploadToken), QWEN_BASE, bytes, mime));
  }
  if (files.length) console.log(`[qwen-proxy] i2v: ${files.length} reference image(s) uploaded`);
  return files;
}

async function handleVideoGenerations(req, res) {
  const body = await parseJsonBody(req);
  // wan3.0-video is not a real upstream model id — chat.qwen.ai drives the Wan
  // engine from a normal chat model with chat_type t2v/i2v.
  const reqModel = isVideoModel(body.model) ? VIDEO_UPSTREAM_MODEL : (body.model || VIDEO_UPSTREAM_MODEL);
  const prompt = body.prompt || "";

  // Optional reference image(s): switches the chat to i2v (image-to-video).
  // Accepts a URL/data-URL string, an array of them, or OpenAI-style objects.
  let files = [];
  try {
    files = await uploadVideoRefs(body);
  } catch (e) {
    return sendError(res, 400, "Reference image upload failed: " + e.message, "invalid_request_error");
  }

  const ticket = randomUUID();
  const startTime = Date.now();
  trackVideoJob(ticket, { status: "processing", data: null, error: null, progress: 0, startTime });

  sendJson(res, 202, { id: randomUUID(), ticket, status: "processing" });

  generateVideo({ prompt, files, model: reqModel }).then(
    (url) => trackVideoJob(ticket, { status: "succeeded", progress: 100, data: url, startTime }),
    (e) => trackVideoJob(ticket, { status: "failed", error: e.message, startTime })
  );
}

// Real voice list from Qwen's TTS config (cached 10 min). The voice is an
// account-level setting upstream — /v1/audio/speech sets it per request — so
// this endpoint is for clients to discover valid `voice` values.
const VOICE_TTL_MS = 10 * 60_000;
let voiceCache = { voices: null, at: 0 };

async function voicesPayload() {
  if (voiceCache.voices && Date.now() - voiceCache.at < VOICE_TTL_MS) {
    return { object: "list", voices: voiceCache.voices };
  }
  let voices = [{ id: "Cherry", name: "Cherry", gender: "", description: "" }]; // fallback
  try {
    const token = getNextToken();
    const url = `${QWEN_BASE}/api/v2/tts/config?omni_speakers=v1&audio_tts_speakers=v1&omni_language=v1&audio_tts_language=v1`;
    const res = await fetch(url, {
      headers: qwenDirectHeaders(token, { "Accept-Language": "en-US,en;q=0.9" }),
    });
    const j = await res.json();
    const d = j?.data || {};
    const map = (arr) => (Array.isArray(arr) ? arr : []).map(v => ({
      id: v.speaker,
      name: v.spk_name || v.speaker,
      gender: v.gender || "",
      description: v.description || "",
    }));
    const seen = new Set();
    const merged = [...map(d.audio_tts_speakers), ...map(d.omni_speakers)].filter(v => {
      if (!v.id || seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });
    if (merged.length) voices = merged;
  } catch (e) {
    console.warn(`[qwen-proxy] could not fetch TTS voices (${e.message}); using fallback`);
  }
  voiceCache = { voices, at: Date.now() };
  return { object: "list", voices };
}

async function handleSpeechGenerations(req, res) {
  const body = await parseJsonBody(req);
  const input = body.input;
  if (!input) return sendError(res, 400, "Missing input text");

  const reqModel = DEFAULT_MODEL;
  const prompt = `Repeat exactly the following text verbatim, with no additional commentary, formatting, or introduction:\n\n${input}`;
  const reqToken = getNextToken();
  const qwenMsgs = buildQwenMessages([{ role: "user", content: prompt }], reqModel, [], null);

  let messageId = null;
  let attempts = 0;
  
  while (attempts < 5) {
    let chatId;
    try {
      chatId = await createChat(reqModel, reqToken);
    } catch (e) {
      if (e.challenge && attempts < 4) {
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }
      return sendError(res, e.challenge ? 503 : 502, e.message, e.challenge ? "upstream_challenge" : "upstream_error");
    }

    try {
      await runCompletion(chatId, reqModel, qwenMsgs, reqToken, (piece, phase, rawJSONStr) => {
        if (rawJSONStr) {
          console.log("[tts-debug]", rawJSONStr);
          try {
            const rawJSON = JSON.parse(rawJSONStr);
            if (rawJSON.id) messageId = rawJSON.id;
            if (rawJSON.response_id) messageId = rawJSON.response_id;
            if (rawJSON.choices && rawJSON.choices[0] && rawJSON.choices[0].message && rawJSON.choices[0].message.id) {
              messageId = rawJSON.choices[0].message.id;
            }
          } catch(e) {}
        }
      });
      
      if (!messageId) {
        throw new Error("Failed to extract message_id from the completion stream");
      }

      const ttsPayload = {
        chat_id: chatId,
        timestamp: Math.floor(Date.now() / 1000),
        messages: [
          {
            id: messageId,
            role: "assistant",
            sub_chat_type: "tts"
          }
        ]
      };

      const ttsUrl = `${QWEN_BASE}/api/v2/tts/completions?chat_id=${encodeURIComponent(chatId)}`;
      const headers = qwenHeaders({ Accept: "text/event-stream" }, reqToken);

      let b64Accumulator = '';
      let pcmBuffers = [];
      
      await ensureBrowser();
      await browserFetchStream(ttsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(ttsPayload),
      }, false, (piece, phase, rawJSONStr) => {
          if (rawJSONStr) {
            try {
              const rawJSON = JSON.parse(rawJSONStr);
              if (rawJSON && rawJSON.choices && rawJSON.choices[0] && rawJSON.choices[0].delta && rawJSON.choices[0].delta.tts) {
                  const b64 = rawJSON.choices[0].delta.tts;
                  b64Accumulator += b64;
                  const validLen = Math.floor(b64Accumulator.length / 4) * 4;
                  if (validLen > 0) {
                      const validB64 = b64Accumulator.substring(0, validLen);
                      b64Accumulator = b64Accumulator.substring(validLen);
                      pcmBuffers.push(Buffer.from(validB64, 'base64'));
                  }
              }
            } catch(e) {}
          }
      });
      
      if (b64Accumulator.length > 0) {
          pcmBuffers.push(Buffer.from(b64Accumulator, 'base64'));
      }

      const pcmData = Buffer.concat(pcmBuffers);
      
      const sampleRate = 24000;
      const numChannels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);

      const wavBuffer = Buffer.alloc(44 + pcmData.length);
      wavBuffer.write('RIFF', 0);
      wavBuffer.writeUInt32LE(36 + pcmData.length, 4);
      wavBuffer.write('WAVE', 8);
      wavBuffer.write('fmt ', 12);
      wavBuffer.writeUInt32LE(16, 16);
      wavBuffer.writeUInt16LE(1, 20);
      wavBuffer.writeUInt16LE(numChannels, 22);
      wavBuffer.writeUInt32LE(sampleRate, 24);
      wavBuffer.writeUInt32LE(byteRate, 28);
      wavBuffer.writeUInt16LE(blockAlign, 32);
      wavBuffer.writeUInt16LE(bitsPerSample, 34);
      wavBuffer.write('data', 36);
      wavBuffer.writeUInt32LE(pcmData.length, 40);
      pcmData.copy(wavBuffer, 44);

      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(wavBuffer);
      res.end();
      await deleteChat(chatId, reqToken);
      break;
    } catch (e) {
      await deleteChat(chatId, reqToken);
      if (e.challenge && attempts < 4) {
        attempts++;
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }
      if (!res.headersSent) {
          return sendError(res, e.challenge ? 503 : 502, e.message, e.challenge ? "upstream_challenge" : "upstream_error");
      } else {
          res.end();
          return;
      }
    }
  }
}

async function handleVideoStatus(res, ticket) {
  const job = videoJobs.get(ticket);
      
  if (!job) {
    return sendJson(res, 404, { error: { message: "Job not found", type: "invalid_request_error" } });
  }
  
  let currentProgress = job.progress;
  if (job.status === "processing" && job.startTime) {
    const elapsedSec = (Date.now() - job.startTime) / 1000;
    // Simulate progress going from 0 to 99 over ~120 seconds
    currentProgress = Math.min(99, Math.floor((elapsedSec / 120) * 99));
  }
  
  return sendJson(res, 200, {
    status: job.status,
    progress: currentProgress,
    data: job.status === "succeeded" ? [{ url: job.data }] : null,
    error: job.error ? { message: job.error, type: "server_error" } : null
  });
}

async function handleUpload(req, res) {
  try {
    const formData = await parseMultipartForm(req);
    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return sendError(res, 400, "No file provided");
    }

    const mime = file.type || "application/octet-stream";
    const filename = file.name || "upload.bin";
    const bytes = Buffer.from(await file.arrayBuffer());

    const reqToken = getNextToken();
    const fileObj = await uploadFile(() => qwenHeaders({}, reqToken), QWEN_BASE, bytes, mime, filename);

    return sendJson(res, 200, {
      url: fileObj.url,
      file_id: fileObj.id,
      filename: filename,
      type: fileObj.type
    });
  } catch (e) {
    return sendError(res, 500, "Upload failed: " + e.message);
  }
}

/**
 * Parse the contents of a <tool_call> block into OpenAI-style calls.
 *
 * Registry-gated when `body.tools` is declared: a name that isn't one of the
 * declared tools means this block was prose or an example, and it renders back
 * as text instead of becoming a phantom call. JSON repair + schema coercion
 * recover the near-right arguments models actually emit. tool_choice /
 * parallel_tool_calls are enforced, not just suggested.
 *
 * With no tools declared (permissive mode) the legacy loose fallbacks apply.
 */
function parseToolCallBlocks(block, body = null) {
  if (!block || typeof block !== "string") return [];
  let text = block.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  const tools = body?.tools;
  let calls = extractToolCalls(text, tools);
  if (calls.length > 0 && body) {
    calls = applyToolPolicy(calls, body, buildRegistry(tools || []));
  }
  if (calls.length > 0) return calls;

  // Loose regex fallbacks: permissive mode only. With a registry in play,
  // an unmatched block is prose — returning it as a call would be wrong.
  if (tools && tools.length > 0) return [];

  const results = [];
  const regex = /\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\}|"[^"]*")[\s\S]*?\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj && typeof obj.name === "string") {
        results.push({
          name: obj.name,
          arguments: typeof obj.arguments === "object" ? JSON.stringify(obj.arguments) : String(obj.arguments || "{}")
        });
      }
    } catch (e) {
      results.push({ name: match[1], arguments: match[2] });
    }
  }
  if (results.length > 0) return results;

  const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
  if (nameMatch) {
    const name = nameMatch[1];
    let argsStr = "{}";
    const argsMatch = text.match(/"arguments"\s*:\s*(\{[\s\S]*\}|"[^"]*")/);
    if (argsMatch) {
      argsStr = argsMatch[1];
    }
    return [{ name, arguments: argsStr }];
  }

  return [];
}

// ============================================================================
// CHAT COMPLETIONS (OpenAI & Anthropic)
// ============================================================================

// Executes one intercepted generate_video call and returns the markdown to show
// the user. Never throws: the failure text goes in the reply, because by the time
// this runs the response headers are already out on the streaming path.
async function runPendingVideoCall(call, abortRef = null) {
  let args = {};
  try {
    args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : (call.arguments || {});
  } catch {
    return `\nVideo generation failed: could not parse the tool arguments.\n`;
  }
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return `\nVideo generation failed: no prompt supplied.\n`;

  try {
    const files = args.image ? await uploadVideoRefs({ image: args.image }) : [];
    console.log(`[qwen-proxy] in-chat video (${files.length ? "i2v" : "t2v"}): ${prompt.slice(0, 80)}`);
    return buildVideoContent(await generateVideo({ prompt, files }, abortRef));
  } catch (e) {
    console.error("[qwen-proxy] in-chat video failed:", e.message);
    return `\nVideo generation failed: ${e.message}\n`;
  }
}

// A search is one full upstream turn with thinking on, and it can fall through
// to the browser transport, so the guard has to be generous: the local TLS
// handshake alone runs 4-12s machine-wide (TODO §1). It exists to stop a wedged
// upstream holding the client's stream open forever, not to bound a slow search.
const SEARCH_TIMEOUT_MS = Number(process.env.QWEN_SEARCH_TIMEOUT_MS || 120000);

// Runs one web search out of a SECOND, isolated Qwen chat. Resolves to Qwen's
// own answer text, throws on failure or timeout.
//
// No tools and no reasoning_effort passed on purpose: that leaves the
// native-plugin kill flags off and auto_search on (buildQwenMessages), and a
// single turn with an empty system block keeps the bare-prompt fast path. That
// exact shape is the only one that makes Qwen search — see Experiment A.
async function runWebSearch(query) {
  const model = DEFAULT_MODEL;
  const token = getNextToken();
  const chatId = await createChat(model, token);
  const msgs = buildQwenMessages([{ role: "user", content: query }], model, [], null, {});
  const abortRef = { abort: async () => {} };
  let timer = null;
  let searchInfo = null;
  try {
    const text = await Promise.race([
      runCompletion(chatId, model, msgs, token, (_piece, _phase, rawJSON) => {
        if (!rawJSON) return;
        try {
          const evt = JSON.parse(rawJSON);
          const info = evt?.choices?.[0]?.delta?.extra?.web_search_info;
          if (Array.isArray(info) && info.length > 0) searchInfo = info;
        } catch {}
      }, abortRef),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          // Without the abort the fetch outlives the turn and keeps a worker page
          // (or a socket) busy for as long as upstream feels like.
          abortRef.abort().catch(() => {});
          reject(new Error(`web search timed out after ${SEARCH_TIMEOUT_MS}ms`));
        }, SEARCH_TIMEOUT_MS);
      }),
    ]);
    return { text, searchInfo };
  } finally {
    clearTimeout(timer);
    deleteChat(chatId, token).catch(() => {});
  }
}

// Executes one intercepted web_search call and returns the markdown to show the
// user. Never throws, same reason as runPendingVideoCall: by the time this runs
// the response headers are already out on the streaming path.
async function runPendingSearchCall(call) {
  const query = searchQueryOf(call.arguments);
  if (!query) return `\nWeb search failed: no query supplied.\n`;
  try {
    console.log(`[qwen-proxy] in-chat web search: ${query.slice(0, 80)}`);
    const { text, searchInfo } = await runWebSearch(query);
    return buildSearchContent(query, text, searchInfo);
  } catch (e) {
    console.error("[qwen-proxy] in-chat web search failed:", e.message);
    return `\nWeb search failed: ${e.message}\n`;
  }
}

async function runPendingImageCall(call, files = [], abortRef = null) {
  let args = {};
  try {
    args = typeof call.arguments === "object" ? call.arguments : JSON.parse(call.arguments || "{}");
  } catch {}
  const rawPrompt = args.prompt || "";
  const { prompt, ratio: promptRatio } = extractPromptRatio(rawPrompt);
  const ratio = normalizeAspectRatio(args.aspect_ratio || promptRatio);
  const isEdit = call.name === IMAGE_EDIT_TOOL_NAME || (Array.isArray(files) && files.length > 0);
  const targetFiles = isEdit ? files.slice(-1) : [];

  if (!prompt.trim()) return `\nImage generation failed: no prompt supplied.\n`;
  try {
    console.log(`[qwen-proxy] in-chat image ${isEdit ? "edit" : "generation"}: ${prompt.slice(0, 80)} (ratio: ${ratio})`);
    const url = await runImagePrompt(prompt, "qwen3.8-max", targetFiles, { aspect_ratio: ratio }, abortRef);
    if (!url) return `\nImage generation failed: upstream returned no image.\n`;
    return `\n\n![Generated Image](${url})\n`;
  } catch (e) {
    console.error("[qwen-proxy] in-chat image generation failed:", e.message);
    return `\nImage generation failed: ${e.message}\n`;
  }
}

// Splits parsed calls into the client's and the ones the proxy answers itself.
// Both routes need the same split, and getting it wrong hands the client a call
// for a tool it never declared.
function splitVirtualCalls(toolCalls) {
  const video = [], search = [], image = [], client = [];
  for (const tc of toolCalls) {
    if (tc.name === VIDEO_TOOL_NAME) video.push(tc);
    else if (tc.name === SEARCH_TOOL_NAME) search.push(tc);
    else if (tc.name === IMAGE_TOOL_NAME || tc.name === IMAGE_EDIT_TOOL_NAME) image.push(tc);
    else client.push(tc);
  }
  return { video, search, image, client };
}

// One search per turn. A generation that emits three of them is asking the same
// question three ways, and each one is a whole extra upstream turn on the
// client's clock. Logged, not silently truncated.
function takeFirstSearch(into, calls) {
  for (const tc of calls) {
    if (into.length === 0) into.push(tc);
    else console.warn(`[qwen-proxy] dropping extra web_search (1 per turn): ${searchQueryOf(tc.arguments).slice(0, 60)}`);
  }
}

// Answers a chat turn with a rendered video instead of text. Renders take
// minutes, so the streaming path opens the SSE stream immediately and leans on
// keepalive comments until the URL lands.
async function respondWithVideo(req, res, { prompt, files, model, wantStream, isAnthropic, conversationId, history }) {
  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const inputTokens = estimateTokens(prompt);
  let keepaliveTimer = null;
  let encoder = null;
  const abortRef = { aborted: false };
  if (req?.on) {
    req.on("close", () => { abortRef.aborted = true; });
  }

  if (wantStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    if (isAnthropic) {
      encoder = new AnthropicStreamEncoder(res, model, id, { inputTokens });
    } else {
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`);
    }
    // A render produces zero bytes for minutes; send active SSE keepalive chunks
    // so OpenCode and other client-side fetch timers don't abort due to idle timeout.
    keepaliveTimer = setInterval(() => {
      if (res.writableEnded) return;
      try {
        if (isAnthropic) {
          encoder?.ping?.();
        } else {
          res.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
          })}\n\n`);
        }
      } catch {}
    }, 5000);
  }

  try {
    const url = await generateVideo({ prompt, files, model: VIDEO_UPSTREAM_MODEL }, abortRef);
    const content = buildVideoContent(url);
    if (conversationId) {
      history.push({ role: "assistant", content });
      saveHistory(conversationId, history).catch(() => {});
    }

    if (!wantStream) {
      if (isAnthropic) {
        return sendJson(res, 200, buildAnthropicResponse(model, id, content, [], { inputTokens }));
      }
      const completionEst = estimateTokens(content);
      return sendJson(res, 200, {
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: inputTokens, completion_tokens: completionEst, total_tokens: inputTokens + completionEst },
      });
    }

    if (encoder) {
      encoder.delta({ content });
      encoder.finish("stop");
    } else {
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    res.end();
  } catch (e) {
    console.error("[qwen-proxy] video chat turn failed:", e.message);
    if (!wantStream) return sendError(res, 502, "Video generation failed: " + e.message, "server_error");
    // Headers are already out; the only way to report is in-band.
    const failure = `Video generation failed: ${e.message}`;
    if (encoder) {
      encoder.delta({ content: failure });
      encoder.finish("stop");
    } else {
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: failure }, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    res.end();
  } finally {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
  }
}

async function handleChatCompletions(req, res, isAnthropic = false) {
  let body = await parseJsonBody(req);
  if (body.messages && body.messages.length > 0) {
    if (body.messages[0].role === "system" && process.env.QWEN_DEBUG) {
      fs.writeFileSync("opencode-system-prompt.txt", JSON.stringify(body.messages[0], null, 2));
    }
  }
  if (body.tools && body.tools.length > 0) {
    const toolNames = body.tools.map(t => t?.function?.name || t?.name || "?");
    console.log(`[qwen-proxy] DEBUG tools received: [${toolNames.join(", ")}]`);
    if (process.env.QWEN_DEBUG) fs.writeFileSync("opencode-tools.json", JSON.stringify(body.tools, null, 2));
  } else {
    console.log(`[qwen-proxy] DEBUG no tools received`);
  }
  if (!body || !Array.isArray(body.messages)) {
    return sendError(res, 400, "Invalid JSON body or missing messages");
  }
  let reqModel = body.model || "qwen3.8-max";
  if (isAnthropic && reqModel.startsWith("claude-")) {
    reqModel = "qwen3.8-max";
  }
  if (isAnthropic) {
    body = translateAnthropicToOpenAI(body);
    if (!body || !Array.isArray(body.messages)) {
      return sendError(res, 400, "Invalid Anthropic messages payload");
    }
  }

  // reqModel already declared above
  const wantStream = body.stream === true;
  const conversationId = conversationIdFor(req, body);
  const history = buildEffectiveHistory(conversationId, body.messages);
  const reqToken = getNextToken();

  let files = [];
  const sourceUrls = body.messages.flatMap(fileUrlsIn);
  try {
    for (const m of body.messages) {
      const urls = fileUrlsIn(m);
      for (const url of urls) {
        const { bytes, mime } = await fetchFileBytes(url);
        const fileObj = await uploadFile(() => qwenHeaders({}, reqToken), QWEN_BASE, bytes, mime);
        files.push(fileObj);
      }
    }
  } catch (e) {
    return sendError(res, 400, "Image upload failed: " + e.message, "invalid_request_error");
  }

  const excludedImageUrls = new Set([...sourceUrls, ...files.map((file) => file.url).filter(Boolean)]);

  // Model-suffix routing: `wan3.0-video` (or any `-video` model) turns this chat
  // turn into a Wan render. Same convention both reference proxies use, and the
  // id is already advertised in /v1/models. Reference images make it i2v.
  if (isVideoModel(reqModel)) {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    const prompt = lastUser ? messageText(lastUser) : "";
    if (!prompt.trim()) {
      return sendError(res, 400, "Video generation needs a text prompt", "invalid_request_error");
    }
    return respondWithVideo(req, res, { prompt, files, model: reqModel, wantStream, isAnthropic, conversationId, history });
  }

  // Model-suffix routing or explicit @image/@edit trigger:
  // 1. Explicit image models (qwen-image, qwen-image-edit, etc.)
  // 2. Prompt contains @image or @edit prefix/tag
  const hasImageFiles = files.some((f) => f.type === "image");
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const rawPrompt = lastUser ? messageText(lastUser) : "";
  const { isTrigger: promptTrigger, prompt: cleanPrompt, ratio: promptRatio } = parseImageCommand(rawPrompt);
  const isImageTriggered = isImageModel(reqModel) || promptTrigger;

  if (isImageTriggered) {
    const ratio = normalizeAspectRatio(body.aspect_ratio || body.size || body.aspectRatio || promptRatio);
    if (!cleanPrompt.trim()) {
      return sendError(res, 400, "Image generation needs a text prompt", "invalid_request_error");
    }
    try {
      const id = "chatcmpl-" + randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const url = await runImagePrompt(cleanPrompt, reqModel, files.slice(-1), { aspect_ratio: ratio });
      const imageMd = `\n\n![Generated Image](${url})\n`;
      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        if (isAnthropic) {
          const encoder = new AnthropicStreamEncoder(res, reqModel, id, { inputTokens: estimateTokens(prompt) });
          encoder.delta({ content: imageMd });
          encoder.close("stop");
        } else {
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: reqModel, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: reqModel, choices: [{ index: 0, delta: { content: imageMd }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: reqModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
        }
        res.end();
        return;
      } else {
        if (isAnthropic) {
          return sendJson(res, 200, buildAnthropicResponse(reqModel, id, imageMd, [], { inputTokens: estimateTokens(prompt) }));
        }
        return sendJson(res, 200, {
          id, object: "chat.completion", created, model: reqModel,
          choices: [{ index: 0, message: { role: "assistant", content: imageMd }, finish_reason: "stop" }],
          usage: { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(imageMd), total_tokens: estimateTokens(prompt) + estimateTokens(imageMd) }
        });
      }
    } catch (e) {
      return sendError(res, 500, `Image generation failed: ${e.message}`, "upstream_error");
    }
  }

  // Offer web search (and optionally Wan video / image editing/generation if explicitly enabled) to tool-capable clients.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const declared = new Set(body.tools.map((t) => normalizeName(toolName(t))));
    const virtualTools = [];
    if (process.env.QWEN_ENABLE_VIDEO === "1") virtualTools.push(VIDEO_TOOL);
    if (process.env.QWEN_ENABLE_SEARCH !== "0") virtualTools.push(SEARCH_TOOL);
    if (process.env.QWEN_ENABLE_IMAGE === "1") {
      if (hasImageFiles) virtualTools.push(IMAGE_EDIT_TOOL);
      virtualTools.push(IMAGE_TOOL);
    }
    for (const virtual of virtualTools) {
      if (!declared.has(normalizeName(toolName(virtual)))) body.tools = [...body.tools, virtual];
    }
  }

  const qwenMsgs = buildQwenMessages(history, reqModel, files, null, body);

  // Resumable thread? A follow-up turn carries only its new message with
  // parent_id set — Qwen supplies history from its own server-side copy, which
  // stops the system prompt and past conversation being re-sent every turn.
  //
  // 1. Explicit id (conversationId): Keyed directly on conversationId.
  // 2. Stateful id-less clients (OpenCode): Keyed on transcript continuation hash.
  //    Matches if incoming messages minus the last message match the prior turn's hash.
  const toolsOn = Array.isArray(body.tools) && body.tools.length > 0;
  let priorSession = null;
  let resumeTurn = false;
  let resumeMsgs = null;
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];

  if (files.length === 0) {
    if (conversationId) {
      priorSession = getSession(conversationId, reqModel);
      if (priorSession) {
        const lastMsg = history[history.length - 1];
        const txt = lastMsg ? messageText(lastMsg) : "";
        if (lastMsg && lastMsg.role !== "assistant" && txt) {
          const text = lastMsg.role === "tool"
            ? `<tool_response name="${lastMsg.name || 'tool'}">\n${txt}\n</tool_response>`
            : txt;
          resumeMsgs = buildQwenMessages([{ role: "user", content: text }], reqModel, [], null, {});
          resumeTurn = true;
        }
      }
    } else if (rawMessages.length >= 2) {
      const prefixHash = hashTranscript(rawMessages.slice(0, -1));
      priorSession = getSession(prefixHash, reqModel);
      if (priorSession) {
        const lastMsg = rawMessages[rawMessages.length - 1];
        const txt = lastMsg ? messageText(lastMsg) : "";
        if (lastMsg && lastMsg.role !== "assistant" && txt) {
          const text = lastMsg.role === "tool"
            ? `<tool_response name="${lastMsg.name || 'tool'}">\n${txt}\n</tool_response>`
            : txt;
          resumeMsgs = buildQwenMessages([{ role: "user", content: text }], reqModel, [], null, {});
          resumeTurn = true;
          console.log(`[qwen-proxy] Resuming stateful thread via transcript prefix hash (parent ${String(priorSession.responseId).slice(0, 8)}...)`);
        }
      }
    }
  }

  // Key under which this completed turn should be saved for subsequent turns
  const sessionSaveKey = (assistantContent) => {
    if (conversationId) return conversationId;
    if (rawMessages.length > 0) {
      return hashTranscript([...rawMessages, { role: "assistant", content: assistantContent || "" }]);
    }
    return null;
  };

  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);

  // `token` must be the one the turn actually ran on, not reqToken: retries
  // rotate the pool and a resumed thread is pinned to its own account, so
  // cleaning up with reqToken hits the wrong bearer and leaves the chat behind.
  const finalize = async (assistantContent, cid, keepThread = false, token = reqToken) => {
    if (assistantContent && conversationId) {
      history.push({ role: "assistant", content: assistantContent });
      saveHistory(conversationId, history).catch(() => {});
    }
    if (keepThread) {
      // The chat IS the history now — deleting it would force the next turn to
      // re-send the whole transcript. Only wipe account-level memories.
      await forgetAllMemories(token);
    } else {
      await Promise.all([deleteChat(cid, token), forgetAllMemories(token)]);
    }
  };

  /** Pull the response_id off SSE frames — it's the parent for the next turn. */
  let latestResponseId = null;
  const grabResponseId = (rawJSONStr) => {
    if (!rawJSONStr || typeof rawJSONStr !== "string") return;
    try {
      const evt = JSON.parse(rawJSONStr);
      const rid = evt?.response_id || evt?.["response.created"]?.response_id;
      if (typeof rid === "string" && rid) latestResponseId = rid;
    } catch {}
  };

  // Per-request abort handle — populated by runCompletion -> browserFetchStream and
  // bound to THIS request's worker page (a pool-wide abort would hit other requests)
  const abortRef = { abort: async () => {} };
  let keepaliveTimer = null; // set once the SSE stream opens
  let clientAborted = false;
  const abortHandler = () => {
    if (!clientAborted && !res.writableEnded) {
      clientAborted = true;
      console.log("[qwen-proxy] Client connection closed early, aborting active stream...");
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      abortRef.abort().catch(() => {});
    }
  };
  // Bound to `res`, NOT `req`: parseJsonBody above fully consumes the request
  // stream, so IncomingMessage 'close' has already fired by the time we get here
  // (measured: req.destroyed === true at this line) and a req listener is born
  // dead — which is why every client hang-up ran the turn to completion against
  // upstream with nobody reading. Response 'close' fires on premature connection
  // termination regardless of body state; the !res.writableEnded guard above
  // separates that from a clean end.
  res.on("close", abortHandler);

  try {
    if (wantStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // SSE keepalive: suppressed reasoning phases and withheld <tool_call>
      // buffers can produce zero bytes for a long stretch, which looks like an
      // idle socket to intermediate proxies. ":" comment lines are the SSE
      // no-op — every client ignores them.
      let lastClientWrite = Date.now();
      const origWrite = res.write.bind(res);
      res.write = (...args) => { lastClientWrite = Date.now(); return origWrite(...args); };
      keepaliveTimer = setInterval(() => {
        if (Date.now() - lastClientWrite < 5000 || res.writableEnded) return;
        try {
          if (isAnthropic) {
            anthropicEncoder?.ping?.();
          } else {
            origWrite(`data: ${JSON.stringify({
              id, object: "chat.completion.chunk", created, model: reqModel,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
            })}\n\n`);
          }
        } catch {}
      }, 5000);

      let anthropicEncoder = null;
      if (isAnthropic) {
        anthropicEncoder = new AnthropicStreamEncoder(res, reqModel, id, {
          inputTokens: estimateTokens(JSON.stringify(body.messages || [])),
        });
      } else {
        res.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: reqModel,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })}\n\n`);
      }
      let hasEmittedContent = false;
      // Routes one OpenAI-style delta through either the Anthropic encoder or an OpenAI SSE chunk
      const emitDelta = (delta) => {
        if (delta && (delta.content || delta.tool_calls)) hasEmittedContent = true;
        if (anthropicEncoder) {
          anthropicEncoder.delta(delta);
          return;
        }
        res.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: reqModel,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`);
      };

      let content = "";
      let attempts = 0;
      let toolBuffer = "";
      let inToolCall = false;
      // The opening tag as the model actually wrote it, so an unparseable block
      // can be re-emitted verbatim instead of vanishing (see below).
      let openToolTag = "<tool_call>";
      // OpenAI streaming clients accumulate tool_calls by `index`, and one
      // generation emits several <tool_call> blocks in separate emitDelta calls.
      // A per-block idx restarts at 0 every time and collides.
      let toolCallIndex = 0;
      let hasEmittedToolCall = false;
      let streamedFinishReason = null;
      const pendingVideoCalls = [];
      const pendingSearchCalls = [];
      const pendingImageCalls = [];
      const capturedImageUrls = new Set();
      let streamStatus = { finished: false };
      while (attempts < 5) {
        let chatId;
        let activeToken = reqToken;
        let parentId = null;
        // Retries rotate to a fresh token — the failed one was likely parked.
        let useResume = resumeTurn && attempts === 0 && !!resumeMsgs;
        if (attempts > 0 && files.length === 0) activeToken = getNextToken();
        if (useResume && priorSession) {
          // Continue Qwen's own thread: same chat, same pinned account.
          chatId = priorSession.chatId;
          if (priorSession.token) activeToken = priorSession.token;
          parentId = priorSession.responseId;
          console.log(`[qwen-proxy] Resuming thread for conversation '${conversationId || "stateful-client"}' (parent ${String(parentId).slice(0, 8)}...)`);
        } else {
          try {
            chatId = await createChat(reqModel, activeToken);
          } catch (e) {
            if (e.challenge && attempts < 4) {
              attempts++;
              await new Promise(r => setTimeout(r, 4000));
              continue;
            }
            if (/quota|rate|limit/i.test(e.message || "") && attempts < 4) {
              flagTokenFailed(activeToken, e.message);
              attempts++;
              continue;
            }
            break;
          }
        }

        try {
          capturedImageUrls.clear();
          streamStatus = { finished: false };
          // Same reason as RESTART_PHASE: a retry replays the turn, so nothing
          // the failed attempt half-buffered may survive into this one.
          toolBuffer = "";
          inToolCall = false;
          toolCallIndex = 0;
          const turnMsgs = useResume ? resumeMsgs : qwenMsgs;
          content = await runCompletion(chatId, reqModel, turnMsgs, activeToken, (piece, _phase, rawJSON) => {
            if (_phase === RESTART_PHASE) {
              // Upstream is replaying this turn — drop the partial tool XML so
              // the replay's first </tool_call> doesn't close a stale fragment.
              toolBuffer = "";
              inToolCall = false;
              toolCallIndex = 0;
              return;
            }
            grabResponseId(rawJSON);
            if (rawJSON) {
              if (rawJSON.includes("image_edit")) console.log("[qwen-proxy] DEBUG rawJSON: ", rawJSON);
              collectImageUrls(capturedImageUrls, rawJSON, excludedImageUrls);
            }
            if (body.tools && body.tools.length > 0) {
              toolBuffer += piece;

              const openMatch = toolBuffer.match(/<tool_calls?>/i);
              if (!inToolCall && openMatch) {
                const textBefore = toolBuffer.substring(0, openMatch.index);
                if (textBefore) {
                  emitDelta({ content: textBefore });
                }
                inToolCall = true;
                openToolTag = openMatch[0];
                toolBuffer = toolBuffer.substring(openMatch.index + openMatch[0].length);
              }

              const closeMatch = toolBuffer.match(/<\/tool_calls?>/i);
              if (inToolCall && closeMatch) {
                const toolBlock = toolBuffer.substring(0, closeMatch.index).trim();
                const toolCalls = parseToolCallBlocks(toolBlock, body);

                if (toolCalls.length > 0) {
                  // generate_video, web_search, and generate_image/edit_image are ours:
                  // hold them back and run them after the turn ends.
                  const { video, search, image, client: clientCalls } = splitVirtualCalls(toolCalls);
                  pendingVideoCalls.push(...video);
                  takeFirstSearch(pendingSearchCalls, search);
                  pendingImageCalls.push(...image);

                  if (clientCalls.length > 0) {
                    for (const call of clientCalls) {
                      hasEmittedToolCall = true;
                      streamedFinishReason = "tool_calls";
                      const chunk = {
                        id: call.id || ("call_" + randomUUID().slice(0, 8)),
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: typeof call.arguments === "object" ? JSON.stringify(call.arguments) : (call.arguments || "{}"),
                        },
                      };
                      emitDelta({ tool_calls: [{ index: toolCallIndex++, ...chunk }] });
                    }
                  }
                } else {
                  // Zero calls means the registry rejected the name — the block
                  // is prose, which is exactly what parseToolCallBlocks says and
                  // what the non-streaming path already does (it never trims
                  // `content` unless a call parsed). Dropping it here emitted a
                  // literally blank turn with finish_reason "stop": the model
                  // invents a tool the client never declared (a websearch, say)
                  // and the user sees nothing at all. Re-emit verbatim.
                  emitDelta({ content: openToolTag + toolBuffer.substring(0, closeMatch.index) + closeMatch[0] });
                }

                inToolCall = false;
                toolBuffer = toolBuffer.substring(closeMatch.index + closeMatch[0].length);
              }

              if (inToolCall) return;

              if (endsWithPartialToolTag(toolBuffer)) return;

              if (toolBuffer) {
                emitDelta({ content: toolBuffer });
                toolBuffer = "";
              }
            } else {
              if (piece) emitDelta({ content: piece });
            }
          }, abortRef, parentId, streamStatus);
          collectImageUrls(capturedImageUrls, content, excludedImageUrls);
          console.log("[qwen-proxy] DEBUG capturedImageUrls: ", Array.from(capturedImageUrls));

          const newImageUrls = Array.from(capturedImageUrls).filter(url => !content.includes(url));
          if (newImageUrls.length > 0) {
            const markdownImages = newImageUrls.map(url => `\n\n![Generated Image](${url})`).join("");
            emitDelta({ content: markdownImages });
            content += markdownImages;
          }

          // A stream that ran to completion with nothing to show means a
          // degraded upstream, not an answer — the usual cause is the browser
          // fallback streaming empty after a WAF captcha solve. Nothing has
          // been emitted yet (content is empty), so a retry is invisible to the
          // client; without it opencode gets a blank turn and finish_reason
          // "length".
          if (!content.trim() && !hasEmittedToolCall && !toolBuffer.trim() && capturedImageUrls.size === 0 && pendingVideoCalls.length === 0 && pendingSearchCalls.length === 0 && pendingImageCalls.length === 0 && attempts < 4) {
            console.warn(`[qwen-proxy] Empty completion (attempt ${attempts + 1}/5) — retrying on a fresh chat/token.`);
            await deleteChat(chatId, activeToken);
            if (conversationId) forgetSession(conversationId);
            resumeTurn = false;
            attempts++;
            continue;
          }
          const saveKey = sessionSaveKey(content);
          if (latestResponseId && saveKey) {
            saveSession(saveKey, { chatId, responseId: latestResponseId, model: reqModel, token: activeToken });
          }
          // "length" is OpenAI's signal for a reply that ran out of room —
          // clients treat it as resumable rather than finished.
          if (!streamStatus.finished && !streamedFinishReason) streamedFinishReason = "length";
          await finalize(content, chatId, !!latestResponseId, activeToken);
          break;
        } catch (e) {
          // A client hang-up is expected, not a fault: runCompletion already
          // logged it with elapsed ms. Cleanup below still runs — the upstream
          // chat exists and its thread is half-written either way.
          if (e.name === "AbortError") {
            console.warn(`[qwen-proxy] stream aborted by client — cleaning up chat ${chatId}.`);
            break;
          } else {
            console.error("[qwen-proxy] DEBUG error in runCompletion loop:", e);
          }
          await deleteChat(chatId, activeToken);
          if (conversationId) forgetSession(conversationId);
          resumeTurn = false;            // retries build a fresh chat with the full collapse
          if (!hasEmittedToolCall && !hasEmittedContent && attempts < 4) {
            attempts++;
            console.warn(`[qwen-proxy] Upstream error on attempt ${attempts}/5 (${e.message}) — retrying on fresh chat/token.`);
            await new Promise(r => setTimeout(r, e.challenge ? 4000 : 1500));
            continue;
          }
          break;
        }
      }

      // Held-back web_search runs first: it is the cheap one, and the turn is
      // usually nothing but "Searching the web." until its result lands.
      if (!abortRef.aborted && !res.writableEnded) {
        for (const call of pendingSearchCalls) {
          if (abortRef.aborted || res.writableEnded) break;
          const searched = await runPendingSearchCall(call, abortRef);
          emitDelta({ content: searched });
          content += searched;
          if (!hasEmittedToolCall) streamedFinishReason = "stop";
        }

        // Held-back generate_video calls run now, with the stream still open —
        // keepalive above covers the minutes a render takes.
        for (const call of pendingVideoCalls) {
          if (abortRef.aborted || res.writableEnded) break;
          const rendered = await runPendingVideoCall(call, abortRef);
          emitDelta({ content: rendered });
          content += rendered;
          if (!hasEmittedToolCall) streamedFinishReason = "stop";
        }

        // Held-back image calls (generate_image / edit_image) run in isolated chats
        for (const call of pendingImageCalls) {
          if (abortRef.aborted || res.writableEnded) break;
          const rendered = await runPendingImageCall(call, files, abortRef);
          emitDelta({ content: rendered });
          content += rendered;
          if (!hasEmittedToolCall) streamedFinishReason = "stop";
        }
      } else if (pendingSearchCalls.length > 0 || pendingVideoCalls.length > 0 || pendingImageCalls.length > 0) {
        console.warn("[qwen-proxy] stream aborted by client — skipping held-back tool execution.");
      }

      if (!abortRef.aborted && (pendingVideoCalls.length || pendingSearchCalls.length || pendingImageCalls.length) && conversationId) {
        const last = history[history.length - 1];
        if (last?.role === "assistant") last.content = content;
        else history.push({ role: "assistant", content });
        saveHistory(conversationId, history).catch(() => {});
      }

      // Anything still buffered when the turn ends is prose — including a
      // <tool_call> the model never closed, which used to be dropped here and
      // cost the client the whole turn. See leftoverText in toolparse.js.
      if (body.tools && body.tools.length > 0) {
        const leftover = leftoverText(toolBuffer, inToolCall, openToolTag);
        if (leftover) emitDelta({ content: leftover });
      }
      if (isAnthropic) {
        anthropicEncoder.finish(streamedFinishReason);
      } else {
        const promptEst = estimateTokens(JSON.stringify(body.messages || []));
        const completionEst = estimateTokens(content);
        res.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: reqModel,
          choices: [{ index: 0, delta: {}, finish_reason: streamedFinishReason || "stop" }],
          usage: { prompt_tokens: promptEst, completion_tokens: completionEst, total_tokens: promptEst + completionEst },
        })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      clearInterval(keepaliveTimer);
      res.end();
      return;
    }

    // Non-streaming
    let content = "";
    let attempts = 0;
    const capturedImageUrls = new Set();
    let streamStatus = { finished: false };
    while (attempts < 5) {
      let chatId;
      let activeToken = reqToken;
      let parentId = null;
      const useResume = resumeTurn && attempts === 0 && !!resumeMsgs;
      if (attempts > 0) activeToken = getNextToken(); // rotate off a likely-parked token
      if (useResume && priorSession) {
        chatId = priorSession.chatId;
        if (priorSession.token) activeToken = priorSession.token;
        parentId = priorSession.responseId;
        console.log(`[qwen-proxy] Resuming thread for conversation '${conversationId || "stateful-client"}' (parent ${String(parentId).slice(0, 8)}...)`);
      } else {
        try {
          chatId = await createChat(reqModel, activeToken);
        } catch (e) {
          if (e.challenge && attempts < 4) {
            attempts++;
            await new Promise(r => setTimeout(r, 4000));
            continue;
          }
          if (/quota|rate|limit/i.test(e.message || "") && attempts < 4) {
            flagTokenFailed(activeToken, e.message);
            attempts++;
            continue;
          }
          const status = e.challenge ? 503 : 502;
          return sendError(res, status, e.message, e.challenge ? "upstream_challenge" : "upstream_error");
        }
      }

      try {
        capturedImageUrls.clear();
        streamStatus = { finished: false };
        const turnMsgs = useResume ? resumeMsgs : qwenMsgs;
        content = await runCompletion(chatId, reqModel, turnMsgs, activeToken, (_piece, _phase, rawJSON) => {
          grabResponseId(rawJSON);
          if (rawJSON) collectImageUrls(capturedImageUrls, rawJSON, excludedImageUrls);
        }, abortRef, parentId, streamStatus);
        collectImageUrls(capturedImageUrls, content, excludedImageUrls);
        const newImageUrls = Array.from(capturedImageUrls).filter(url => !content.includes(url));
        if (newImageUrls.length > 0) {
          const markdownImages = newImageUrls.map(url => `\n\n![Generated Image](${url})`).join("");
          content += markdownImages;
        }
        // Same empty-completion retry as the streaming route above.
        if (!content.trim() && capturedImageUrls.size === 0 && attempts < 4) {
          console.warn(`[qwen-proxy] Empty completion (attempt ${attempts + 1}/5) — retrying on a fresh chat/token.`);
          await deleteChat(chatId, activeToken);
          if (conversationId) forgetSession(conversationId);
          resumeTurn = false;
          attempts++;
          continue;
        }
        const saveKey = sessionSaveKey(content);
        if (latestResponseId && saveKey) {
          saveSession(saveKey, { chatId, responseId: latestResponseId, model: reqModel, token: activeToken });
        }
        await finalize(content, chatId, !!latestResponseId, activeToken);
        break;
      } catch (e) {
        await deleteChat(chatId, activeToken);
        if (conversationId) forgetSession(conversationId);
        resumeTurn = false;
        if (attempts < 4) {
          attempts++;
          console.warn(`[qwen-proxy] Upstream error on non-stream attempt ${attempts}/5 (${e.message}) — retrying on fresh chat/token.`);
          await new Promise(r => setTimeout(r, e.challenge ? 4000 : 1500));
          continue;
        }
        const status = e.challenge ? 503 : 502;
        return sendError(res, status, e.message, e.challenge ? "upstream_challenge" : "upstream_error");
      }
    }

    let artifacts = [];
    if (body.qwen_mode === "web_dev") {
      const regex = /```(html|css|js|javascript)\n([\s\S]*?)```/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        let ext = match[1];
        if (ext === "javascript") ext = "js";
        let mime = "text/plain";
        if (ext === "html") mime = "text/html";
        if (ext === "css") mime = "text/css";
        if (ext === "js") mime = "application/javascript";
        
        artifacts.push({
          filename: `artifact.${ext}`,
          mime_type: mime,
          content: match[2].trim()
        });
      }
    }

    // Shared tool-call extraction for both response formats
    let textBefore = content;
    let parsedToolCalls = [];
    // ALL blocks, not just the first. One generation routinely emits several as
    // the model switches tools between segments — replay of the real capture
    // f60e7973 yields 4. A non-global .match() silently dropped 3 of them.
    const toolMatches = [...content.matchAll(/<tool_calls?>([\s\S]*?)<\/tool_calls?>/gi)];
    if (body.tools && body.tools.length > 0 && toolMatches.length) {
      const toolCalls = toolMatches.flatMap((m) => parseToolCallBlocks(m[1].trim(), body));
      // generate_video, web_search, and image tools are ours — run them and put the result in
      // the reply instead of handing the call to the client.
      const { video: videoCalls, search: searchCalls, image: imageCalls, client: clientCalls } = splitVirtualCalls(toolCalls);
      const firstSearch = [];
      takeFirstSearch(firstSearch, searchCalls);
      const nonStreamAbort = { aborted: false };
      if (req?.on) req.on("close", () => { nonStreamAbort.aborted = true; });
      if (toolCalls.length > 0) textBefore = content.substring(0, toolMatches[0].index).trim();
      for (const call of firstSearch) {
        if (nonStreamAbort.aborted || res.writableEnded) break;
        textBefore += await runPendingSearchCall(call, nonStreamAbort);
      }
      for (const call of videoCalls) {
        if (nonStreamAbort.aborted || res.writableEnded) break;
        textBefore += await runPendingVideoCall(call, nonStreamAbort);
      }
      for (const call of imageCalls) {
        if (nonStreamAbort.aborted || res.writableEnded) break;
        textBefore += await runPendingImageCall(call, files, nonStreamAbort);
      }
      if (clientCalls.length > 0) {
        parsedToolCalls = clientCalls.map(tc => ({
          id: "call_" + Math.random().toString(36).slice(2, 11),
          type: "function",
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
          }
        }));
      }
    }

    if (isAnthropic) {
      let anthropicRes = buildAnthropicResponse(reqModel, id, textBefore, parsedToolCalls, {
        inputTokens: estimateTokens(JSON.stringify(body.messages || [])),
      });
      if (artifacts.length > 0) {
        anthropicRes.artifacts = artifacts;
      }
      sendJson(res, 200, anthropicRes);
    } else {
      const promptEst = estimateTokens(JSON.stringify(body.messages || []));
      const completionEst = estimateTokens(content);
      let openAiRes = {
        id,
        object: "chat.completion",
        created,
        model: reqModel,
        choices: [{ index: 0, message: { role: "assistant", content: textBefore }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptEst, completion_tokens: completionEst, total_tokens: promptEst + completionEst },
      };

      if (parsedToolCalls.length > 0) {
        openAiRes.choices[0].message = {
          role: "assistant",
          content: textBefore || null,
          tool_calls: parsedToolCalls
        };
        openAiRes.choices[0].finish_reason = "tool_calls";
      } else if (!streamStatus.finished) {
        // Stream severed without an answer-phase terminator — report it the
        // OpenAI way so resumable clients know.
        openAiRes.choices[0].finish_reason = "length";
      }

      if (artifacts.length > 0) {
        openAiRes.artifacts = artifacts;
      }
      sendJson(res, 200, openAiRes);
    }
  } finally {
    res.off("close", abortHandler);
    // Anything that threw mid-stream would otherwise orphan this request's 5s
    // keepalive interval forever.
    if (keepaliveTimer) clearInterval(keepaliveTimer);
  }
}

async function handleClearConversation(res, conversationId) {
  const existed = clearConversation(conversationId);
  // Memories are per-account, so wipe the account this thread actually ran on.
  // Must be read before forgetSession drops the entry.
  const token = getSession(conversationId)?.token || getNextToken();
  forgetSession(conversationId); // the stored thread no longer matches memory
  await forgetAllMemories(token);
  return sendJson(res, 200, { ok: true, conversation_id: conversationId, cleared: existed });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Conversation-Id",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // Serve static frontend files
    if (req.method === "GET" && !url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/anthropic/")) {
      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const ext = path.extname(filePath);
      const mimeTypes = {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon"
      };
      
      // Basic security check to prevent directory traversal
      const publicDir = path.join(process.cwd(), "public");
      const fullPath = path.join(publicDir, filePath);
      
      if (fullPath.startsWith(publicDir)) {
        try {
          const data = await fsPromises.readFile(fullPath);
          const contentType = mimeTypes[ext] || "application/octet-stream";
          res.writeHead(200, { "Content-Type": contentType });
          return res.end(data);
        } catch (err) {
          // If a file isn't found and it doesn't look like an API request, return 404
          if (err.code === "ENOENT" && ext) {
            return sendError(res, 404, "File not found");
          }
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, model: DEFAULT_MODEL, tokens: getActiveTokens().length });
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return sendJson(res, 200, modelsPayload());
    }
    // =========================================================================
    // 3) OpenAI Chat Completions & Anthropic Messages
    // =========================================================================
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages" || url.pathname === "/anthropic/v1/messages")) {
      const isAnthropic = url.pathname.includes("/messages");

      // Pass to handler where body will be parsed and logged
      return await handleChatCompletions(req, res, isAnthropic);
    }
    if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
      return await handleSpeechGenerations(req, res);
    }
    if (req.method === "GET" && url.pathname === "/v1/audio/voices") {
      return sendJson(res, 200, await voicesPayload());
    }
    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      return await handleImageGenerations(req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/images/edits") {
      return await handleImageEdits(req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/videos/generations") {
      return await handleVideoGenerations(req, res);
    }
    if (req.method === "POST" && (url.pathname === "/v1/upload" || url.pathname === "/v1/files")) {
      return await handleUpload(req, res);
    }
    if (req.method === "GET" && url.pathname === "/v1/videos/status") {
      const ticket = url.searchParams.get("ticket");
      if (!ticket) return sendError(res, 400, "Missing ticket parameter", "invalid_request_error");
      return await handleVideoStatus(res, ticket);
    }
    const videoStatusMatch = url.pathname.match(/^\/v1\/videos\/([^/]+)$/);
    if (req.method === "GET" && videoStatusMatch) {
      return await handleVideoStatus(res, videoStatusMatch[1]);
    }
    const convMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+?)(?:\/reset)?$/);
    if (convMatch && (req.method === "DELETE" || req.method === "POST")) {
      return await handleClearConversation(res, decodeURIComponent(convMatch[1]));
    }
    return sendError(res, 404, `No route for ${req.method} ${url.pathname}`, "not_found");
  } catch (e) {
    const status = e.statusCode || 500;
    // A client-fault status is expected, not a crash — one line, no stack. Full
    // stacks stay for real 5xx so genuine bugs keep their trace.
    if (status >= 500) console.error("[qwen-proxy] Unhandled error:", e);
    else console.warn(`[qwen-proxy] ${status} ${req.method} ${url.pathname}: ${e.message}`);
    if (!res.headersSent) {
      sendError(res, status, e.message || "Internal error", status >= 500 ? "server_error" : "invalid_request_error");
    } else {
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// Startup: launch browser FIRST, then start the HTTP server
// ---------------------------------------------------------------------------

async function start() {
  console.log("[qwen-proxy] Starting up...");
  console.log(`[qwen-proxy] Token pool: ${getActiveTokens().length} token(s)`);

  if (QWEN_DIRECT) {
    console.log("[qwen-proxy] Direct fetch mode: Chrome deferred until first fallback need.");
    console.log("[qwen-proxy] Memory file: " + MEMORY_FILE);
  } else {
    // Launch Chrome + navigate to chat.qwen.ai (baxia.js initialization)
    try {
      await initBrowser(QWEN_COOKIES, getActiveTokens());
    } catch (e) {
      console.error(`[qwen-proxy] FATAL: Could not initialize browser: ${e.message}`);
      console.error("[qwen-proxy] Make sure Chrome is installed at:", process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
      process.exit(1);
    }
  }

  server.listen(PORT, HOST, () => {
    console.log(`[qwen-proxy] Proxy listening on http://${HOST}:${PORT}`);
    console.log(`[qwen-proxy] Default model: ${DEFAULT_MODEL}`);
    console.log(`[qwen-proxy] Thinking: ${QWEN_THINKING ? "enabled" : "filtered"}`);
    console.log(`[qwen-proxy] Forget memories: ${QWEN_FORGET_MEMORIES}`);
    if (!QWEN_DIRECT) console.log(`[qwen-proxy] Memory file: ${MEMORY_FILE}`);
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[qwen-proxy] Shutting down...");
  await closeBrowser();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
process.on("uncaughtException", async (err) => {
  console.error("\n[qwen-proxy] UNCAUGHT EXCEPTION:", err);
  try { await closeBrowser(); } catch(e) {}
  process.exit(1);
});
process.on("unhandledRejection", async (reason) => {
  console.error("\n[qwen-proxy] UNHANDLED REJECTION:", reason);
  try { await closeBrowser(); } catch(e) {}
  process.exit(1);
});

start().catch(async (e) => {
  console.error("[qwen-proxy] Fatal:", e);
  try { await closeBrowser(); } catch(err) {}
  process.exit(1);
});
