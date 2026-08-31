# QwenProxy

OpenAI- and Anthropic-compatible HTTP proxy in front of **chat.qwen.ai**'s private
web API. Turns a browser chat session into an API endpoint that coding agents
(opencode, Claude-style SDK clients, curl) can drive, including tool calling,
image/video generation, TTS and file upload.

There is no official API behind this. Everything is reverse-engineered from the
web client, so upstream behaviour changes without notice and the interesting parts
of this repo are the workarounds. **Read [Findings and caveats](#findings-and-caveats)
before changing the SSE parse loop or the tool-call path** — every rule there was
paid for with a broken agent run.

Open work is in [TODO.md](TODO.md).

---

## Quickstart

```bash
npm install
npm start
```

`npm start` is `node --env-file=.env server.js`.

> **Never start it as plain `node server.js`.** `.env` is silently ignored, no
> debug capture happens, and every flag falls back to its default. This has
> already cost one wasted debug session. Symptom: the banner prints
> `Forget memories: true` while `.env` says `false`.

Health check:

```bash
curl -s http://127.0.0.1:8787/health
```

```json
{"ok":true,"model":"qwen3.8-max","tokens":3}
```

`tokens` is the number of live tokens in the pool. If it is `0`, start the token
farmer (below) — nothing will work.

### Tokens

Tokens are **not** pasted into `.env` any more. The pool is files on disk, farmed
by a headless Camoufox bot that registers throwaway accounts and solves the
Alibaba slider captcha:

| Path | Meaning |
|---|---|
| `farmer/output/tokens.txt` | one JWT per line, the pool |
| `farmer/output/exhausted.txt` | tokens the proxy has retired; subtracted from the pool |

`server.js:119-171` re-reads both files (stat-cached) on every request, so the
farmer can top the pool up while the proxy runs. `server.js:204` appends to
`exhausted.txt` when a token is provably dead.

Run the farmer daemon in a second terminal — it keeps at least 3 live tokens:

```bash
py farmer/daemon.py
```

`QWEN_TOKEN` / `QWEN_TOKENS` in `.env` still work as a manual override, and
`.env.example` still documents the old copy-from-localStorage flow. Both are
legacy; prefer the pool.

### Point opencode at it

`~/.config/opencode/opencode.json` — an OpenAI-compatible provider on
`http://127.0.0.1:8787/v1`, model id `qwen3.8-max`. Then:

```bash
opencode run -m qwen/qwen3.8-max "your prompt"
```

---

## Endpoints

All defined in one raw `http.createServer` handler at `server.js:2796` (no
Express). Route table starts at `:2810`.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ok, model, tokens}` |
| GET | `/v1/models`, `/models` | static list (`modelsPayload`, `server.js:1180`) — no upstream fetch. Includes a pinned `qwen3.8-max-preview`, which upstream dropped but still serves, and `wan3.0-video` |
| POST | `/v1/chat/completions` | OpenAI shape, `stream` true/false, `tools` supported. A `-video` model renders instead of answering; with client tools declared, `generate_video` and `web_search` are offered and intercepted |
| POST | `/v1/messages`, `/anthropic/v1/messages` | Anthropic shape (`anthropic.js`) |
| POST | `/v1/audio/speech` | TTS, 24 kHz PCM → WAV |
| GET | `/v1/audio/voices` | Qwen's real voice list (~78), cached 10 min |
| POST | `/v1/images/generations` | Text-to-Image |
| POST | `/v1/images/edits` | Image-to-Image editing (multipart or JSON body) |
| POST | `/v1/videos/generations` | reference image switches `t2v` → `i2v`. Both now take the same transport (`isVideoChat`, `video.js`); the three call sites used to test `t2v` alone, so an i2v request was streamed down the text path |
| GET | `/v1/videos/status`, `/v1/videos/:id` | polls `/api/v1/tasks/status/:id` upstream |
| POST | `/v1/upload`, `/v1/files` | OSS4-HMAC-SHA256 signed PUT (`upload.js`) |
| GET/POST | `/v1/conversations/:id`, `/v1/conversations/:id/reset` | server-side memory for stateless clients |
| GET | `/generated/*` | serves generated images from `QWEN_ARTIFACT_DIR` |
| GET | anything else | static files from `public/` |

---

## Architecture

```
client (opencode / SDK / curl)
   |
   v
server.js  — routing, OpenAI<->Qwen translation, token pool, retries
   |
   +-- DIRECT path (default)  ssxmod.js mints WAF cookies, plain fetch
   |      directRunCompletion() — buffers the whole body, then parses
   |
   +-- BROWSER path (fallback) browser.js — Puppeteer-stealth worker pool
   |      runCompletion() — true streaming out of page context
   |
   +-- toolparse.js  — tool-call extraction, JSON repair, generation picking
   +-- store.js      — per-conversation memory for clients that keep no thread
   +-- anthropic.js / artifacts.js / upload.js / chat.js
```

### Two transports, one contract

Both paths call back with `(piece, phase, rawEventJSON)`, so the tool-call
pipeline downstream is shared.

* **Direct** (`QWEN_DIRECT=1`, default). `ssxmod.js` generates the
  `ssxmod_itna` / `ssxmod_itna2` anti-bot cookies (37-field device fingerprint,
  LZW + custom base64, cached 15 min, re-minted on challenge). No browser. The
  body is read with `res.text()` and parsed afterwards — which is why the direct
  path can afford a whole-body **pre-scan** and the browser path cannot.
* **Browser** (fallback, or `QWEN_DIRECT=0`). Puppeteer-stealth, `QWEN_WORKERS`
  parallel contexts. Chrome is **lazily** launched on first fallback need, so
  startup is <1s instead of ~25s. Solves the simple Aliyun slider itself via a
  heuristic drag (`DRAG_DEAD_ZONE` / `DRAG_RATIO`). The **puzzle** captcha needs
  computer vision, delegated to an optional sidecar on `CAPTCHA_SOLVER_URL`
  (default `http://127.0.0.1:5555`) — **not shipped in this repo**
  (`farmer/captcha_solver.py` is a class module, not a server). `initBrowser`
  probes it and warns when it is absent; sliders keep working, puzzles fail.

Any direct failure transparently replays the turn on the browser path.

### Tool calling

Qwen has no public function-calling API for this endpoint, so tools are injected
into the prompt as a `<tools>` block and the model answers with
`<tool_call>{"name":..., "arguments":...}</tool_call>` XML inside `delta.content`.
`toolparse.js` turns that back into OpenAI `tool_calls`.

The parser is registry-gated and repair-happy — an unknown tool name is treated
as prose, not a phantom call, and malformed JSON goes through progressive repair
(trailing commas, Python literals, smart/single quotes, double-encoded argument
strings, unterminated tails), then schema coercion (`"50"` → `50`), then
`applyToolPolicy` for `tool_choice` / `parallel_tool_calls`.

**Qwen also has a second, native channel** (`delta.function_call`) that fires
unpredictably. See [The two tool-call channels](#the-two-tool-call-channels).

---

## Configuration

`.env`, loaded by `--env-file`. Node's parser does **not** reliably strip an
inline `# comment` after a value — keep comments on their own line.

| Var | Default | What it does |
|---|---|---|
| `PORT` | `8787` | listen port |
| `QWEN_HOST` | `127.0.0.1` | bind address. Loopback on purpose — see [findings](#the-listener-is-loopback-only). `0.0.0.0` exposes an unauthenticated, `CORS: *` proxy holding live tokens |
| `QWEN_MAX_BODY_BYTES` | `67108864` | request-body cap; over it the route answers 413 instead of buffering |
| `QWEN_TOKENS` / `QWEN_TOKEN` | *(empty)* | manual token override; leave empty, use the farmer pool |
| `QWEN_CLIENT_VERSION` | `0.2.83` | sent as the required `Version` header. Stale versions get WAF-rejected; copy the real one from DevTools if completions start failing |
| `QWEN_THINKING` | `false` | surface the model's reasoning in the output. The *request* still enables thinking (see below) |
| `QWEN_DIRECT` | `1` | `0` = always use Puppeteer |
| `QWEN_WORKERS` | `1` | parallel browser contexts. `2` measured 2.3× throughput with no captcha-rate increase once warm |
| `QWEN_FORGET_MEMORIES` | `true` | wipe the memories Qwen auto-saves server-side after each turn |
| `QWEN_TOOL_CLAMP` | `8000` | per-tool-result char cap in the collapsed prompt |
| `QWEN_TOOL_BUDGET` | `24000` | total tool-result budget before older results get elided |
| `QWEN_MAX_CONTEXT` | `60000` | estimated-token ceiling before history truncation |
| `QWEN_TIMEOUT` | `120000` | browser-path completion timeout (ms) |
| `QWEN_SEARCH_TIMEOUT_MS` | `120000` | wall clock for one in-chat `web_search`; on expiry the upstream fetch is aborted and the turn says so |
| `QWEN_VIDEO_POLL_MAX` | `60` | video status polls before giving up |
| `QWEN_VIDEO_POLL_MS` | `20000` | delay between video status polls. Default budget is 20 min — a render routinely outlives the old 3 min |
| `QWEN_MEMORY_MAX_BYTES` | `524288` | `memory.json` size cap |
| `MEMORY_FILE` | `./memory.json` | server-side conversation memory |
| `QWEN_ARTIFACT_DIR` | `./generated` | where generated images land |
| `QWEN_COOKIES` | *(empty)* | legacy manual WAF cookies; `ssxmod.js` + stealth handle this now |
| `QWEN_USER_AGENT` | Chrome 149 UA | direct-path UA |
| `CHROME_PATH` | standard Windows path | Chrome binary |
| `CAPTCHA_SOLVER_URL` | `http://127.0.0.1:5555` | **optional** CV sidecar for the puzzle captcha; not shipped here |
| `QWEN_DEBUG` | unset | verbose payload/event logging |
| `QWEN_DEBUG_SSE_FILE` | unset | **wire capture** — append every raw SSE event as JSONL. Leave disarmed in normal operation |

`.env` is gitignored. Tokens are session credentials — keep them out of version
control.

### Thinking / fast mode

`reasoning_effort` on the request maps to Qwen's thinking switch
(`server.js:816`):

| `reasoning_effort` | Result |
|---|---|
| `"none"`, `"low"` | `thinking_enabled: false` — fast mode |
| anything else, incl. `null`/absent | thinking on |

`QWEN_THINKING` only controls whether the reasoning **text** reaches the client;
the model spends the tokens either way.

Do **not** hard-disable thinking when tools are declared, even though one
reference proxy does. `qwen3.8-max-preview` rejects `thinking_enabled=false` with
`invalid_input`. Released `qwen3.8-max` accepts both — that is why fast mode works
today. If `invalid_input` ever appears, this is the cause.

---

## Tests

Two tiers. The unit tier is fast and offline; the loop tier needs a live proxy and
burns real quota.

```bash
node --check server.js && node --check toolparse.js && node --check browser.js  # syntax
node --check video.js && node --check websearch.js                             # virtual tools
npm test                     # node --test tests/*.test.mjs — includes the harvest replay
node test_client_thread.js   # LIVE, needs the proxy up + QWEN_DEBUG=1 (stateful clients)
node test_agent_loop.js      # LIVE, needs the proxy up, takes minutes, burns quota
```

`tests/fc_harvest.test.mjs` — four suites, all replaying real captures from
`tests/fixtures/`: native `function_call` harvest + suppression gate + snapshot
semantics; WAF challenge detection; multiplexed generations
(`sse_multigen.jsonl`); one generation with many `finished` segments
(`sse_multisegment.jsonl`). Its `replay(stopOnFinished)` gate also pins the
browser read loop's segment semantics.

`tests/upload_ssrf.test.mjs` — the attachment-URL guard, with the resolver and
`fetch` both injected so nothing touches DNS or the network. Covers every blocked
range, split public/private answers, redirect hops into a private range,
IPv4-mapped IPv6, NAT64, bracketed IPv6 literals, and the redirect limit. See
[findings](#attachment-urls-are-resolved-before-they-are-fetched).

`tests/websearch.test.mjs` — the virtual `web_search` tool: the registry gate in
both directions, the plural `{"queries": [...]}` shape the model actually emits,
every argument shape `searchQueryOf` accepts and every one it refuses, the
normalized-name collision that stops the injection when a client ships its own
search tool, and the `<tool_call>` echo strip (closed and unclosed) using the
verbatim tail from the first live run. See
[findings](#in-chat-web-search-a-second-isolated-chat).

`test_agent_loop.js` — drives a full opencode-style agent loop (client owns the
thread, canned tool results, up to 14 turns) and fails on malformed JSON,
duplicate calls, raw `<tool_call>` XML leaking into `content`, or never reaching a
final answer. **This is the only check that catches the whole class of bug that
broke real agent runs** — unit tests cannot see it. Run it after touching history
building, the SSE parse loop, or the tool-buffer logic.

Last full run (2026-08-24, after the segment-`finished` and multi-block fixes):

```
turn 1: 10.8s  finish=tool_calls  text=70b  calls=1  todowrite(527b)
turn 2: 10.9s  finish=tool_calls  text=82b  calls=2  todowrite(531b) bash(159b)
...
turn 7: 13.5s  finish=stop  text=680b  calls=0
PASS — every tool call parsed, no duplicates, no leaked XML, loop reached a final answer
```

Same task took 10 turns before those fixes and 7 after: recovering every
`<tool_call>` block in a generation means fewer round trips, which is also the
cheapest latency win available. Narration survives too (`text=0b` on every turn
beforehand).

`tests/live_*.mjs` need a live proxy too. Everything else in `tests/` is offline.

---

## Debugging playbook

### 1. Capture the wire

```
QWEN_DEBUG_SSE_FILE=./sse_debug.jsonl
```

Restart with `npm start`, reproduce, then read the JSONL. **Disarm it afterwards**
— it appends forever.

Each line is `{"event": <raw Qwen SSE event>}`. The shape you care about:

```js
event.response_id                      // WHICH GENERATION — always check this
event.choices[0].delta.phase           // answer | think | thinking_summary | code_interpreter
event.choices[0].delta.status           // "finished" = end of a SEGMENT, not the response
event.choices[0].delta.content          // the prompt-emulated XML channel
event.choices[0].delta.function_call    // the native channel (snapshot semantics)
```

Useful one-liner — group a capture by generation and count segments:

```bash
node --input-type=module -e "
import fs from 'node:fs';
const evs=fs.readFileSync('sse_debug.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l).event);
const per=new Map();
for(const e of evs){const d=e.choices?.[0]?.delta||{};const r=per.get(e.response_id)||{fin:0,len:0};
  if(d.status==='finished'&&(!d.phase||d.phase==='answer'))r.fin++;
  if(d.content)r.len+=d.content.length; per.set(e.response_id,r);}
console.log([...per].map(([k,v])=>k?.slice(0,8)+' fin='+v.fin+' len='+v.len).join('\n'));
"
```

### 2. Read the client's side of the story

When opencode rejects a call, its own database says exactly why — no guessing
from the proxy side. opencode keeps SQLite at
`~/.local/share/opencode/opencode.db` (or `%USERPROFILE%\.local\share\opencode\opencode.db` on Windows).

**Copy `.db`, `.db-wal` and `.db-shm` together** into a temp dir before opening.
A bare `.db` copy misses everything still in the WAL while opencode is running —
this looked like "the session doesn't exist" for a run that had just finished.
File logging is off by default, so `log/` is usually stale; the DB is the source
of truth.

Tables: `session`, `message`, `part`, `todo`. `part.data` is JSON with `type`
(`tool` / `text`), `tool`, `callID`, `state.status`, `state.input`,
`state.error`. That is where you find, verbatim, the arguments opencode was
handed and the schema error it raised.

### 3. Map a capture back to a client message

Chats appear in the capture in the same order as the assistant messages in the
DB. Pair them up, and a client-side error pins to one `response_id`, whose frames
you can then dump in isolation.

---

## Findings and caveats

Hard-won upstream behaviour. Everything here is measured from wire captures, not
inferred.

### `status: "finished"` marks the end of a SEGMENT, not the response

The single most expensive misreading in this repo, and it bit twice.

Qwen raises `status:"finished"` at the end of every phase **and** every tool
segment. Measured 2026-08-24: 5 answer-phase `finished` frames in one generation
while the model switched `write` → `bash` → `code_interpreter` → `todowrite`, 16
across one capture. Both parse loops used to `break` on the first one.

Replay of the real 165-frame generation `f60e7973`:

| Loop | Recovered |
|---|---|
| `break` on first `finished` | 514 b, **1** tool call |
| `continue` (current) | 1731 b, **4** tool calls, all parse |

The direct path buffers the whole body before parsing, so stopping early buys
nothing: record the segment end and keep reading (`server.js:622`). No `finished`
frame in any capture carries content, so skipping its body loses nothing —
re-verify that if you change this.

The earlier, narrower version of this lesson still holds: `finished` also fires
after `thinking_summary`, so treating *any* `finished` as the terminator kills the
stream right before the answer even arrives.

### One generation, several `<tool_call>` blocks

Direct consequence of the fix above, and two downstream sites could not cope with
the plural — both fixed at the same time:

* **Non-streaming** used a non-global `content.match(...)`, so
  it took the **first** block and silently dropped the rest. Now `matchAll` +
  `flatMap` (`server.js:2689`), with `textBefore` taken from the first block's index.
* **Streaming** numbered calls with a per-block `idx` starting at 0.
  OpenAI streaming clients accumulate `tool_calls` by
  `index`, so block 2's index-0 collided with block 1's. Now a `toolCallIndex`
  counter (`server.js:2316`) that lives for the whole response and resets per
  attempt and on `RESTART_PHASE`.

Guarded by the multi-segment suite in `tests/fc_harvest.test.mjs`, which replays
`tests/fixtures/sse_multisegment.jsonl` and asserts reading past `finished`
recovers strictly more calls than breaking, and that each recovered block parses.

### One SSE body can carry two generations of the same turn

A single 200 event-stream can interleave two generations of the **same** turn,
frame by frame, each with its own `response_id`, its own `input_tokens`, and its
own `finished`. Real capture (`sse_multigen.jsonl`, chat `2c533116`, 107 frames):

```
=== d586b790  len=517  ...tail: "\"content\": \"Run stats     <- truncated mid-JSON
=== 1e168bdc  len=748  ...tail: "\"priority\": \"high\"}]}}\n</tool_call>"  <- complete
```

Concatenating them produces exactly what broke real runs: valid blocks, duplicate
blocks, and half-written blocks. Client-side that shows up as a turn that just
*stops* — opencode's extractor needs a closing `</tool_call>` (`server.js:2687`),
so the malformed batch is dropped and nothing executes.

Fix: `pickGeneration` (`toolparse.js:276`) pre-scans the buffered body and picks
one generation — balanced `<tool_call>`/`</tool_call>` count first, then length —
and returns `null` when there is nothing to choose between, so ordinary
single-generation streams are untouched. Wired in at `server.js:593`, foreign
frames skipped at `:601`. The browser path cannot pre-scan a live stream, so it
locks onto the first content-bearing `response_id` and ignores the rest
(`server.js:1025`, in the `browserFetchStream` chunk callback — the in-page loop
forwards every frame raw).

Multiplexing is **intermittent** — it did not fire in either verification run, so
it has an offline suite against the captured body. When it does fire the log says:

```
[qwen-proxy] 2 generations in one stream — keeping 94dd2f35, dropping the rest.
```

### The two tool-call channels

| Channel | Field | Accumulate by |
|---|---|---|
| Prompt-emulated XML | `delta.content` → `<tool_call>…</tool_call>` | append |
| Qwen native | `delta.function_call` | **OVERWRITE** |

`delta.function_call.arguments` uses **snapshot semantics** — each frame is the
full arguments-so-far, not a delta. Measured on a 52-frame capture: last
snapshot 500 chars, concatenation of all frames 10810 chars and does not parse.
`makeFCHarvester` (`toolparse.js:323`) overwrites, and flushes when the tool
*name* changes so a second call cannot silently destroy the first.

Nobody in the 12 reference proxies documents this. Rfym21 (752★) and its fork
`+=` the arguments — a latent bug there, do not copy it.

Qwen's own executor also tries to run these natively and rejects unknown names
with `Tool <name> does not exists.` in the answer text. That is suppressed, but
**only when a call was actually harvested and the name is one of ours**
(`toolparse.js:310`). Blanket suppression deletes a genuine failure signal and
makes runs fail silently.

### An unparseable `<tool_call>` block is prose, not silence

The registry is the only gate on a parsed call (`toolparse.js:191` — unknown name
returns null; `applyToolPolicy` checks `tool_choice`/`parallel_tool_calls` and
nothing else, so a missing required argument never drops a call). `toolparse.js`
states the contract: unknown names "render back as text, exactly as the model
wrote them".

The non-streaming path honours that by accident — it only trims `content` when a
call parsed. The streaming path did not: on zero parsed calls it discarded the
whole block and emitted nothing (`server.js:2420`). Net effect was a **literally
blank turn** with `finish_reason: "stop"`. The empty-completion retry below
cannot rescue it either, because raw `content` still holds the discarded markup,
so `!content.trim()` is false.

This is not a corner case. Qwen knows its own native plugin tools by name, so
when a client declares tools but no search tool, the model reaches for
`web_search` — with Qwen's argument spelling, `queries` as an array, not
`query`. Reproduced live: `web_search` is not in the client's registry, parse
yields zero calls, and pre-fix the client received 0 bytes of content. The
streaming path now re-emits the block verbatim, matching non-streaming.

**The same turn has a second way to go blank: the model never writes
`</tool_call>`.** Captured 2026-08-25 (chat `d24c4b53`): the block ended
`]\n</parameter>\n</function>\n`, borrowing a different tool syntax. The close
regex never matched, so `inToolCall` stayed true, `if (inToolCall) return`
withheld every later piece for a tag that never came, and the leftover flush at
the end of the turn was itself gated on `!inToolCall` — so nothing was emitted at
all. The empty-completion retry stays asleep too: it requires `!toolBuffer.trim()`
and the buffer is full. Zero bytes, `finish_reason: "stop"`, no warning in the
log. Fixed in `leftoverText` (`toolparse.js`): a buffer left open flushes with its
opening tag prepended, exactly as the closed-block case does.

**Tag prefixes must all be held, or a frame boundary eats the call.** The
streaming loop buffers a tail that could still grow into `<tool_call>`. That
prefix list was hand-written and skipped `<tool_c`, `<tool_ca` and `<tool_cal`,
so an SSE frame ending on one of those three emitted the fragment as text and
left the remainder (`l>\n{"name"...`) unable to match the open regex — the whole
call rendered as prose. Every byte still arrives, which is why this hid: only an
assertion on the *parsed call* catches it. Now `PARTIAL_TOOL_TAGS` /
`endsWithPartialToolTag` in `toolparse.js`, shared with the test that sweeps every
frame boundary in the string.

**There is no web search on a tools-on turn.** `auto_search` starts as
`!isFastMode` (`server.js:826`) and is then forced `false` by the kill-flag block
(`server.js:843`) whenever the client declares tools — same mutual exclusivity as
the video handoff. A tool-enabled client that wants search has to bring its own
fetch tool and an explicit URL; opencode ships `webfetch`, never a `websearch`.

The flag turned out not to be the cause, though — see
[Experiment A](#experiment-a-auto_search-is-safe-the-prompt-shape-is-the-suppressor).

### Three feature-config flags keep the native channel asleep

```
"enable_tools": false,
"enable_function_call": false,
"tool_choice": "none",
```

Sent on the tools branch (`server.js:839-853`). Present in five independent
reference proxies. Enabling Qwen's native function-calling makes upstream
intercept custom local tool names. `tool_choice: "none"` is the *upstream*
tool_choice, not the client's — it is correct to send it while still declaring
tools to the model via prompt. Do not "fix" it as a contradiction.

Adding these flags alone made the native channel go quiet: post-patch capture of
the original failing prompt had **0** `function_call` frames. The harvester is
now dormant belt-and-braces, proven offline but never exercised live.

**Do NOT add these flags to the video/image branch.** Those features use
upstream-native async tasks and disabling the native layer can suppress the task
handoff.

### Experiment A: `auto_search` is safe, the prompt shape is the suppressor

Run live 2026-08-25 to test whether the kill-flag block was the only thing
standing between a tools-on turn and native search. It was not. Three probes, all
against the live upstream:

| Probe | Config | Outcome |
|---|---|---|
| A1 — search grounding | tools declared, `auto_search: true` | no search; model emitted a `web_search` block instead |
| A2 — tool parsing | tools declared, `auto_search: true` | `finish_reason: tool_calls`, 1 clean `write` call |
| A3 — control | **no tools**, `auto_search: true` | **searched** — real price, real date, `[[2]]` citation marker |

Two conclusions, both load-bearing:

1. **`auto_search: true` does not break tool parsing** (A2). The kill-flag block's
   worry about it was unfounded, and `Sakuralaaa_qwen2api-mine`'s config — which
   ships `auto_search` live alongside all the other flags
   (`backend/upstream/payload_builder.go:57`) — was sound.
2. **Flipping the flag buys nothing anyway** (A1 vs A3). Search fires on the bare
   single-turn fast path and not on the tools-on path, which collapses history into
   `User:` / `Assistant:` transcript form (`server.js:810`). It is the **prompt
   shape**, not the feature flag. So search and tools-on genuinely do not coexist —
   for a different reason than the code comment claimed.

A3 also exposed a behaviour worth knowing before wiring anything up: after
searching successfully, the model still emits a `web_search` `<tool_call>` block
narrating the plugin it just used. Harmless on the bare path, but it means a
virtual `web_search` has to be registered in `body.tools` or that block now
surfaces as raw text (see the unparseable-block section above).

`server.js` was reverted to its pre-experiment state; the flags stand as they
were. Recorded here so nobody re-runs it. The conclusion is what the shipped
search path is built on — see below.

### In-chat web search: a second, isolated chat

A tools-on turn has no search at all: the kill flags switch Qwen's own
`web_search` off so emulated `<tool_call>` blocks survive. Experiment A above
says the flag is not the reason it stays off — the **prompt shape** is, and a
tools-on turn always has that shape. So the only way to get a search out of a
turn that also has tools is to ask somewhere else.

`runWebSearch` (`server.js:1952`) opens a second upstream chat and asks the query
as a bare, one-turn, tool-less message: no `tools`, no `reasoning_effort`, no
system parts, so the kill flags never fire, `auto_search: !isFastMode` stays true
and the request lands on the bare single-turn fast path — the exact shape A3
searched on. The answer comes back as synthesized prose with `[[n]]` citation
markers, not a SERP, which is why nothing parses it.

Everything else is `generate_video`'s wiring reused (`splitVirtualCalls` feeds
both), with four differences worth knowing:

* **One search per turn**, `takeFirstSearch` (`server.js:2008`). Extra calls are
  logged as dropped rather than dropped quietly, because a model that emits five
  searches costs five full upstream turns.
* **Wall clock, and a real abort.** `QWEN_SEARCH_TIMEOUT_MS` (default 120000)
  races the completion; `directRunCompletion` binds `abortRef.abort`, so the
  timeout actually cancels the in-flight fetch instead of leaving it running
  behind a rejected promise. Generous on purpose: a search is a whole upstream
  turn and can fall through to the browser transport.
* **The A3 narration is stripped.** The isolated chat runs with native plugins
  on — that is the point — and it narrates them: the first live run returned the
  answer plus a `<tool_call>` block for the search upstream had already done, and
  that block reached the client looking like a failed call. `buildSearchContent`
  (`websearch.js`) cuts closed blocks and an unclosed tail.
* **`normalizeName` gates the injection** (`server.js:2177`). A client that ships
  its own `webSearch` keeps it; injecting ours too would put two schemas behind
  one name with only one of them wired to anything.

`pendingSearchCalls` is also in the empty-completion retry guard
(`server.js:2494`): a search turn is usually nothing but "Searching the web."
plus a held-back call, and without it that turn reads as empty and gets retried
from the top. Both post-turn loops leave `finish_reason` alone once a *client*
tool call went out (`if (!hasEmittedToolCall)`) — downgrading `tool_calls` to
`stop` tells the client the turn is over and its own tool never runs. That bug
was in the video loop too; one fix covers both.

Measured live 2026-08-25, streaming, one client tool declared:

```
"current price of Bitcoin in USD"   47.7s  finish=stop        content=624b  (real prices + [[3]] markers)
"use your write tool"              13.2s  finish=tool_calls   1 client call, 0 content
```

Two upstream turns with thinking on is 45–75 s, and there is no way around it
short of a fast-mode search chat. Known limitation, model-side not proxy-side:
asked for a price *and* today's date, it searched the price only.

### In-chat video: two doors, one engine

The kill flags above and the video handoff are mutually exclusive, so a single
upstream request can never be both tools-on and a render. Both doors therefore
open a **separate** upstream chat via `generateVideo` (`server.js:1480`), which
blocks until a media URL appears:

* **Model suffix.** Any `-video` model id (`isVideoModel`, `video.js`) makes a
  chat turn render instead of answer — `wan3.0-video` is already in `/v1/models`,
  so it shows up in client model pickers with no client work.
  `handleChatCompletions` short-circuits to `respondWithVideo` before
  `buildQwenMessages`. Convention borrowed from the reference proxies (see
  below), so clients that already speak Qwen2API need no changes.
* **Virtual tool.** When the client declares tools, `generate_video`
  (`VIDEO_TOOL`) is appended to `body.tools`. That single append is deliberate:
  `buildQwenMessages` renders `body.tools` into the `<tools>` schema block *and*
  `parseToolCallBlocks` validates parsed calls against the same list — inject
  into one only and every call is silently discarded as prose
  (`tests/video_task_ids.test.mjs` asserts both directions). The call is filtered
  out of what the client receives and executed by `runPendingVideoCall`.

Two consequences worth knowing:

* Held-back calls run **after** the model's turn ends, not inline: `onDelta` is
  synchronous and a render takes minutes. The stream stays open on keepalive.
* A render always takes the browser transport (`isVideo` skips direct) and the
  poll loop calls `ensureBrowser()`, so one in-chat video holds a Chrome worker
  for up to `QWEN_VIDEO_POLL_MAX * QWEN_VIDEO_POLL_MS` (default 20 min).

And one upstream quirk that needed a prompt, not code. The native executor still
sees the injected call and answers `Tool generate_video does not exists` inside
the model's own turn. `toolparse.suppressed()` keeps that out of the client
stream, but the model has already read it — measured behaviour was an apology
("the video engine is not responding") plus a fallback still image, shipped
just ahead of the video that then rendered fine. The awareness prompt therefore
tells the model the result is appended after its turn and that the rejection is
spurious.

**No awareness line for tool-less chats.** Injecting one unconditionally would
push a system part into every plain request, which destroys the bare-single-turn
fast path (`server.js:802`) and reshapes all traffic into the `User:`/`Assistant:`
collapse. Tool-less clients get the `wan3.0-video` model id instead.

**Delivery shape, and why it is not the refs' shape.** Both reference proxies
emit `<video controls="controls">URL</video>` with the URL as the element's text.
That is `<video>` *fallback* content — a browser that can play video never shows
it — so a client which renders the HTML draws an empty 0:00 player with no media.
Verified in opencode's desktop UI. `buildVideoContent` (`video.js`) therefore
emits `src="URL"`, with `&` escaped so a signed URL's `&copy=`/`&reg=` is not
parsed as a character reference, embedding `<a href="URL">Download Video</a>`
inside the `<video>` tag as HTML5 native fallback content.

In HTML-capable renderers (OpenCode desktop), the video player renders cleanly with
zero redundant text underneath. In renderers where `<video>` is stripped or unsupported,
the inner `<a>` tag survives to provide the download link.

Inline playback still depends on the client. opencode's desktop renderer
(`oc://renderer`, verified against desktop 1.18.16) sets no CSP — its
`addRendererHeaders` adds only CORS and a document policy — and sanitizes with
DOMPurify under `USE_PROFILES: {html, mathMl}`, which allows `video`, `source`
and `src`. It plays. Its **served** UI (`opencode serve`, same asar) does send
one:

```
img-src 'self' data: https: blob:; media-src 'self' data:; connect-src * data: blob:
```

`https:` on images, not on media — so remote video is blocked there no matter
what markup we emit, and `connect-src`/`blob:` does not help because a `blob:`
media URL is still governed by `media-src`. Only a `data:` URI would pass, which
means base64-inlining megabytes into content that then replays as history.
Nothing to fix proxy-side; `<a href="...">Download Video</a>` is the native fallback there.

### Stateful clients own their thread

opencode and the Anthropic SDK resend the whole transcript every turn and send no
`x-conversation-id`. `conversationIdFor` (`server.js:1203`) returns `null` for
them, and the store used to bucket every such client into one shared `"default"`
conversation, appending only the client's *last* message. Real consequence: a
user's TUI thread got answered with unrelated curl test traffic prepended,
including the same prompt three times.

Worse, the store path flattens through `normalizeRole` + `messageText`, which
drops `tool_calls` and `m.name` — so `role:"tool"` became `user`, tool results
lost their `<tool_response name=…>` wrapper, and the clamp/elision budget never
engaged: every file body re-sent in full, every turn.

Now: **no id means the client owns the thread** — messages pass through untouched
and nothing is persisted (`server.js:1219`, plus the `&& conversationId` guard on
`finalize` at `:2216`). Clients that *do* send an id still get server-side memory.
Guarded by `test_client_thread.js`.

### WAF challenge detection must not keyword-scan a 200 stream

`looksLikeChallenge` used to scan the body for
`access verification|verify that you are|captcha|risk|…`. On a 200 event-stream
**that body is the model's own answer** — any reply containing "risk" or "captcha"
was read as a WAF block and threw the whole turn at the Puppeteer fallback.
Demonstrated live, not inferred: a one-line question *about* captchas matched.

Now (`ssxmod.js:292-333`): on a 200 event-stream only the hard markers
`FAIL_SYS_USER_VALIDATE|RGV587_ERROR` count. Non-stream bodies are error pages
and keep the full loose scan. Mid-stream WAF frames were already caught per-event.
The thrown message names the marker that fired.

### An empty stream is not an answer

Both routes used to `break` out of the retry loop on any non-throwing
`runCompletion`, including `content === ""`, producing a blank turn with
`finish_reason:"length"` and no retry. Guard added: empty content **and** no tool
call **and** no partial tool buffer **and** no image artifacts → delete the chat,
forget the session, rotate token, retry. Nothing has been emitted yet, so the
retry is invisible to the client. `server.js:2494` (streaming), `:2634`
(non-streaming).

### direct → browser fallback must not fuse two attempts

When the direct path fails mid-stream the browser replays the turn from the top
through the same `onDelta`. Attempt 1's half-written `<tool_call>` used to fuse
with attempt 2's output, and attempt 2's first `</tool_call>` closed the stale
fragment. A `RESTART_PHASE` sentinel (`server.js:966`, emitted `:998`) now tells
the streaming consumer to clear `toolBuffer`/`inToolCall` (`:2364`).

### Bind the abort handler to `res`, never `req`

A client hang-up used to be invisible: the turn ran to completion against
upstream with nobody reading it, burning a token and a worker per abandoned
request. So a client that timed out and retried paid for N full generations,
which is the server-side half of a "rate limit / anti-bot" banner.

Cause, and it is a trap worth remembering: `parseJsonBody` fully consumes the
request stream, and `IncomingMessage` `'close'` tracks *that stream* closing — so
by the time the handler binds its listener, `req.destroyed` is already `true`
(measured, not inferred) and the listener is born dead. `res` `'close'` fires on
premature connection termination regardless of body state, and the existing
`!res.writableEnded` guard separates it from a clean end.

Now `res.on("close", abortHandler)` (`server.js:2260`, released at `:2775`).
Measured after the fix — upstream aborted 633 ms in, no retry, no stack:

```
[qwen-proxy] client hung up after 633ms on the direct path — nothing to fall back for.
[qwen-proxy] stream aborted by client — cleaning up chat a252ea03-…
```

Regression check is the pair, not the abort alone: hang up mid-stream and see
those two lines, then run a normal stream to completion and see `data: [DONE]`
with **no** `Client connection closed early` — `res` `'close'` fires on the clean
end too, and only the guard tells them apart.

### Session resume via `parent_id` is disabled whenever tools are on

Resuming a tool thread via `parent_id` **severs the stream** upstream (empty
reply, `finish=length`). Verified 2026-08-23. So resume *and* saveSession are both
skipped when tools are declared, and the entire transcript plus every tool schema
re-uploads on every round trip. Plain-chat resume still works and is a large win
there.

This is the dominant latency cost and it grows with conversation length. See
[TODO.md](TODO.md).

### Tool results must sit next to their call

`buildQwenMessages` used to push `<tool_response>` into the system block, so in
the collapsed prompt the result appeared *above* the `<tool_call>` it answered.
Scrambled order produced `Tool edit does not exists.` refusals and phantom
failures on multi-round loops. Tool results now render as sequential user turns
adjacent to their triggering call.

### Tri-State Reasoning Effort Mapping (Fast / Auto / Thinking)

The proxy maps client `reasoning_effort` parameters to Qwen's native upstream `featureConfig`:
* `"none"` / `"low"` / `"fast"` / `"off"` → `thinking_mode: "off"`, `auto_thinking: false` (Fast mode)
* `"medium"` / `"auto"` → `thinking_mode: "auto"`, `auto_thinking: true` (Auto thinking mode)
* `"high"` / `"max"` (or omitted default) → `thinking_mode: "Thinking"`, `auto_thinking: false` (Full thinking mode)

This allows tool-capable clients (like OpenCode with its model variant picker) to toggle directly between fast generation, auto-routed reasoning, and deep thinking.

### Held-Back Execution Abort Guards

Virtual tools (`generate_video`, `web_search`) are intercepted during streaming and executed server-side at the tail of the turn. Both held-back execution loops (`pendingSearchCalls`, `pendingVideoCalls`) are strictly guarded by `abortRef.aborted` and `res.writableEnded`.

If a client disconnects or times out mid-stream:
1. The stream abort handler terminates the in-flight chat.
2. The proxy immediately skips all pending video/search tasks instead of running unneeded sub-chats.
3. Inside `generateVideo`'s task-polling loop, active polling is aborted on every iteration if the client socket closes, preventing 20-minute background browser hangs.

### Native WHATWG FormData & Zero-Dependency Uploads

Multipart request handling for image editing (`/v1/images/edits`) and file attachments (`/v1/upload`, `/v1/files`) uses Node 22 native WHATWG `FormData` via `new Response(Readable.toWeb(req)).formData()`.
* Zero temporary disk writes or unlinks.
* Streamlined memory buffers directly passed to upload handlers.
* Third-party `formidable` dependency completely eliminated.

### Emergency Virtual Tool Kill Switches

Virtual tool injection into client `body.tools` can be disabled via environment variables:
* `QWEN_ENABLE_VIDEO=0` — disables `generate_video` tool injection.
* `QWEN_ENABLE_SEARCH=0` — disables `web_search` tool injection.

### Smaller upstream facts

* Qwen never sends `[DONE]`. The terminator is `delta.status === "finished"` on
  the answer phase — with the segment caveat above.
* The opening `response.created` event carries `parent_id` and `response_id`.
* Video task polling moved: `/api/v2/tasks/:id` → `/api/v1/tasks/status/:id`.
* `i2v` chat_type is required for image-to-video; `t2v` silently drops
  attachments.
* TTS is 24 kHz (16 kHz is STT input). Voice is an account-level setting.
* Prompt char limit ~180k before upstream fails unpredictably.
* SSE keepalive (`: keepalive\n\n` every 15s of silence) prevents CDN timeouts
  during long thinking phases.
* JWT expiry is checked locally before spending a request (`isTokenExpired`).
* Token failures are classified, not lumped: quota-shaped or expired → permanent
  exhaust; WAF challenge → park 5 min; rate limit → park 60s. Retries pick a
  fresh token.

### A rejected tool call is not automatically a proxy bug

Worked example, 2026-08-24. opencode reported:

```
The write tool was called with invalid arguments: SchemaError(Missing key at ["filePath"])
```

Chasing it through opencode's DB gave the exact rejected input
(`{"content": "42\n17\n83\n…"}`, `callID call_kvl4m9oru`), which mapped to one
capture chat, whose 217 native `function_call` frames showed the model's own final
snapshot was **valid JSON containing only `content`**. The model omitted
`filePath`; opencode was right to reject; the model self-corrected next turn.

The same turn *did* expose a real proxy bug — the segment-`finished` one above —
but only because the wire was checked instead of assumed. Check the client's DB
and the capture before editing the parser.

### Cleanup must use the token the turn actually ran on

`handleChatCompletions` picks `reqToken` once, but the turn can end up on a
different account: a retry rotates the pool (`activeToken = getNextToken()`), and
a resumed thread is pinned to `priorSession.token`. Cleanup that quotes `reqToken`
then sends the wrong bearer — the chat is never deleted and the memory wipe lands
on someone else's account.

Fixed 2026-08-24 in three places: both catch blocks (`:2279`, `:2374`) and, more
importantly, `finalize` itself (`:1987`), which is the **success** path and takes
the token as its fourth argument now. An external review caught the two catch
blocks; the success path was found by grepping every caller.

Symptom if it regresses: orphan chats accumulating in the chat.qwen.ai sidebar of
accounts that didn't serve the request.

### `data += chunk` corrupts any body that isn't ASCII

`readBody` accumulated into a string, which calls `toString()` on each `Buffer`
independently. A UTF-8 sequence split across a TCP segment boundary decodes as
replacement characters on both sides. Proven on the same 175-byte body split
mid-character:

```
old (data += chunk): "\":\"���用中文回答 "   mojibake: true
new (concat first) : "\":\"请用中文回答 🎯"   mojibake: false
```

Now `Buffer.concat(chunks).toString("utf8")` (`server.js:1157`). Any CJK, Cyrillic
or emoji prompt large enough to span two segments was silently mangled before
this. Same function now caps the body at `QWEN_MAX_BODY_BYTES` (64 MB default) and
returns 413 rather than accumulating without bound — it stops buffering but keeps
draining, because destroying the request kills the response with it and the client
sees a reset instead of the status.

### The listener is loopback-only

`server.listen(PORT, HOST)` with `HOST` defaulting to `127.0.0.1`
(`server.js:115`, the `listen` call at `:2947`). It used to omit the host, which
binds `0.0.0.0`. That matters
because the proxy answers every route with `Access-Control-Allow-Origin: *` and
holds live account tokens: on a shared network any page in any browser on any host
could drive it. Set `QWEN_HOST=0.0.0.0` deliberately if you need off-box access,
and put auth in front of it if you do.

### Attachment URLs are resolved before they are fetched

`fetchFileBytes` (`upload.js:105`) exists to fetch whatever `image_url` a client
puts in a message, so it cannot use the host allowlist that `artifacts.js` gets
away with — that one only ever re-fetches Qwen's own output. Instead the hostname
is resolved and **every** returned address is checked against a `net.BlockList`
of non-public ranges (`upload.js:26`) before a socket is opened. Without it,
`{"image_url": {"url": "http://169.254.169.254/latest/meta-data/"}}` makes the
proxy an SSRF hop to cloud metadata and to every service on the LAN.

Four things that are easy to get wrong here, all covered by
`tests/upload_ssrf.test.mjs`:

* **Check every answer, not the first.** A hostname with one public and one
  private A record must be refused outright.
* **Re-check every redirect hop.** `fetch` follows redirects silently, so a
  public host can `302` straight at the metadata endpoint. The loop uses
  `redirect: "manual"` and re-resolves each hop, and rejects a `Location` that
  leaves http(s).
* **`net.BlockList` already handles IPv4-mapped IPv6.** `::ffff:169.254.169.254`
  matches the plain `169.254.0.0/16` rule, verified rather than assumed. NAT64
  (`64:ff9b::/96`) needs its own entry.
* **Alternate literal encodings are not a bypass.** `new URL()` normalizes
  `http://2130706433/` and `http://0x7f000001/` to `127.0.0.1` before any check
  runs. It also *keeps the brackets* on an IPv6 literal, so `hostname` is
  `[::1]` and must be stripped before it reaches the resolver.

What is left open: resolve-then-connect has a DNS-rebinding window — an attacker
who controls the zone can re-point the name between the check and the socket.
Closing it means pinning the resolved IP with an undici dispatcher and a custom
`connect.lookup`, i.e. a new dependency. Not worth it while the listener is
loopback-only; do it before exposing the proxy off-box.

### What an external static review caught, and what it got wrong

A second model reviewed the whole tree cold, 2026-08-24. Useful, and the
false-positive pattern is worth knowing before trusting the next one.

Real: the `reqToken` cleanup bug above; `solveCaptchaCVInFrame(frame)` missing its
`pg` argument (`browser.js:949`, crashes on the NC→puzzle upgrade);
`forgetAllMemories()` called with no token; no request-body cap; `upload.js`
`fetchFileBytes` has no SSRF guard while `artifacts.js` has an allowlist;
`payload.size = "16:9"` was overriding image generation's `1:1`; `chat.js`
checked a `health.tokenSet` field that `/health` has never sent; three vestigial
`try {} finally {}` wrappers; `videoJobs` never evicted.

Wrong, and instructive:

* **"Path traversal on `/generated/` and `/public/`."** Not exploitable. Input is
  `url.pathname`, and `new URL()` normalizes `..`, `%2e%2e` and (for http) `\`
  before `path.join` ever sees it; `/generated/` additionally runs
  `path.basename`. All six vectors tested, every one contained. The reviewer
  reasoned about `path.join` in isolation without tracing the input.
* **"`forgetAllMemories()` sends `Bearer undefined`, so it is a no-op."** No —
  `qwenHeaders(extra, tokenOverride)` falls back to `getNextToken()`. It wiped a
  *random* account's memories, which is a different bug with a different fix.
* **"`chars/3` over-counts CJK, so truncation fires too early."** Backwards. It
  *under*-counts (Qwen is ~1 token/char on CJK), so truncation fires too **late**
  and the prompt gets cut upstream instead.
* **"Allowlist hosts in `upload.js` like `artifacts.js` does."** That would kill
  the feature, for the reason in the section above.
* **"The SSRF fix touches the call chain, so bolt it on now or pay later."**
  It doesn't. `fetchFileBytes` was already `async` and both call sites already
  `await` it, so the guard dropped into one function and nothing else moved.
* **"Guard the fire-and-forget callers before relaxing `unhandledRejection`."**
  There are none to guard — every async function in `server.js` is awaited or
  `.catch()`ed. The handler stays as-is.

The gap: it flagged nothing behavioral. Everything in the sections above —
segment-`finished`, multi-block tool calls, the `tool_calls` index collision,
multiplexed generations — came from replaying captures, not from reading code. A
cold static read will not find them. Replay the fixtures.

---

## Files

| File | What |
|---|---|
| `server.js` | routing, translation, token pool, retries, both completion paths, prompt collapse |
| `browser.js` | Puppeteer-stealth worker pool, captcha solving, in-page SSE reader |
| `ssxmod.js` | WAF cookie minting (LZW + custom base64), challenge detection |
| `toolparse.js` | tool-call extraction, JSON repair, schema coercion, `pickGeneration`, `makeFCHarvester` |
| `store.js` | `memory.json` conversation store for clients that send an id |
| `anthropic.js` | Anthropic Messages shape in/out |
| `artifacts.js` | generated-image handling |
| `video.js` | video task-id extraction, `<video>` markup, `-video`/`i2v` predicates, `generate_video` schema, poll budget |
| `websearch.js` | `web_search` schema, query extraction from the shapes the model emits, result rendering + `<tool_call>` echo strip |
| `upload.js` | OSS4-HMAC-SHA256 signed uploads; SSRF-guarded attachment fetch |
| `chat.js` | interactive terminal REPL — imports `server.js` in-process, then streams against it |
| `farmer/` | Python token farmer: `daemon.py` (pool keeper), `main.py`, `captcha_solver.py` |
| `scripts/` | `pool_spike.mjs` (worker throughput), `quick_fetch.mjs`, `install_dependencies.ps1` |
| `sse_tui_run.jsonl`, `sse_todowrite_ref.jsonl` | raw captures kept at the repo root — see below |
| `tests/` | offline test tier: `fc_harvest.test.mjs` (harvest replay), `worker_pool.test.mjs` (waiter logic), `video_task_ids.test.mjs` (task-id shapes + the tool-registry invariant), `websearch.test.mjs` (`web_search` registry gate, argument shapes, echo strip), `upload_ssrf.test.mjs` (attachment-URL guard), fixtures in `tests/fixtures/` |
| `test_agent_loop.js`, `test_client_thread.js` | LIVE suites at the repo root (quota-burning / needs `QWEN_DEBUG=1`) |
| `public/`, `generated/` | static assets, generated images |
| `TODO.md` | open work |

### Captures kept as fixtures

The replay fixtures live in `tests/fixtures/` and run as part of `npm test`.

| File | Why it exists |
|---|---|
| `sse_todowrite.jsonl` | native-channel harvest; 52 original frames + 51 post-patch, kept for the channel diff |
| `sse_multigen.jsonl` | the two-generations-in-one-body case, both `response_id`s preserved |
| `sse_multisegment.jsonl` | one generation (`f60e7973`, 165 frames) raising `finished` 5 times — the segment-vs-response regression fixture |
| `sse_todowrite_ref.jsonl` (repo root) | pristine 52-frame original |
| `sse_tui_run.jsonl` (repo root) | 9 generations across 8 chats from a real TUI run; the raw source the two fixtures above were carved from |

`memory_pre_history_fix.json` is a snapshot from before the stateful-client fix.

---

## Reference implementations

12 shallow clones in `../qwen-refs/` (34 MB). All are other people's
chat.qwen.ai proxies; they were mined for the flags and mitigations above.

| Repo | ★ | Good for |
|---|---|---|
| `YuJunZhiXue_qwen2API` (Go) | 935 | canonical flag set; blocked-tool-name detect + retry (`main.go:7733-7790`, `:3785`) |
| `Rfym21_Qwen2API` (JS) | 752 | native harvest sites. **Their accumulator `+=`s arguments (`tool-prompt.js:490`) — broken for snapshots, do not copy** |
| `smanx_qwen2api` (JS) | 159 | `tasks/上传附件.md` — captured SSE trace of Qwen's *own* native tools, incl. `function_id` |
| `gloria-29_qwen2API-fixed` (Py) | 0 | richest mitigation set: tool-name obfuscation, `truncation_recovery`, `refusal_cleaner`, `tool_few_shot`, `schema_compressor` |
| `yelihua77-source_qwen2API` (Py) | 7 | best prose: README FAQ §5/§6 + troubleshooting table on the `does not exists` error |
| `sabyaghosh_qwen2api-admin` | 1 | SSE keepalives, `finish_reason` injection, empty-stream retry |
| `dijiaozhibei-top_Qwen2API_Go` | 2 | reads `function_call` but only as a has-content probe |
| `noobd3mon_qwen2api` (Py) | 0 | smallest readable reference (39 KB); has the three flags |
| `Saurabh-gzp_qwen2api` (Py) | 0 | Anthropic/Responses endpoint shapes |
| `Sakuralaaa_qwen2api-mine` (Go) | 1 | fork of YuJunZhiXue |
| `GrothKeiran_Qwen2API-AgentFix` (JS) | 0 | fork of Rfym21, identical line numbers, adds nothing |
| `encryptarun_qwen-api` | 57 | not yet mined |

Separately, `../qwen3.8-api` (UltraFEmotes, "Syde", Next.js/Vercel, 180 files) was
the source for the ssxmod port, `parent_id` sessions, tool-result elision budget,
JWT expiry, the v1 video endpoint and the pinned-models idea. Deliberately **not**
ported from it: Supabase token pool, serverless architecture, admin dashboard, API
key management, watermarks, i18n, Discord auth, proxy pool.

Their file map, if you need to go back:
`lib/ssxmod.ts`, `lib/qwen.ts` (headers, `classifyRefusal`, `qwenDeltas`),
`lib/qwenSessions.ts`, `lib/tokens.ts`, `lib/tools.ts` (ToolStream, budget
elision, JSON repair), `lib/conversation.ts` (`stripTurnLabels`), `lib/tts.ts`,
`lib/media.ts`, `lib/upload.ts`.

---

## Housekeeping

* Restore `memory.json` after live testing — snapshot it first, and remove test
  conversations afterwards.
* Disarm `QWEN_DEBUG_SSE_FILE` when you are done debugging.
* `.env`, `*.log`, `memory.json`, `generated/` and the debug dumps are gitignored.
* Deletions go to the Recycle Bin, never `rm`/`Remove-Item`.
