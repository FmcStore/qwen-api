# TODO

Open work, most useful first. Everything here is deferred on purpose — the
reasoning is preserved so the next person doesn't re-derive it. Background for
all of it is in [README.md](README.md#findings-and-caveats).

`plan.md` (Rounds 1–3, the native-harvest work order) and `plan_old.md` (the
Phase 1–5 port from the Syde reference) are the historical record. Everything
they scheduled is done; what they *deferred* is below.

---

## 1. Latency — tool-thread session resume (SHIPPED 2026-08-25)

**Resolved via `parent_id` session resume on tool threads.**

Re-tested live against upstream Alibaba backend on 2026-08-25:
- Removed the `!toolsOn` gates in `server.js` (lines 2194, 2503, 2642).
- Multi-turn tool calls and follow-ups now resume upstream sessions using `parent_id` instead of re-uploading full transcripts.
- Turn 2 response latency dropped from ~13s to ~8.9s (non-streaming) and Turn 3 conversational follow-ups completed in **6.33s** (streaming).
- Stream survived cleanly across both streaming and non-streaming multi-turn tool probes with zero empty replies or `finish_reason: length` failures.

---

## 2. The browser fallback — exercised live once; observability gap remains

**Update 2026-08-24 (late):** this section previously said the fallback had never
run end-to-end. That is no longer true: at ~23:47 the direct path hit a real WAF
challenge and worker w0 solved a live Aliyun slider (`slider_w0_pre/post_1.png`;
only the three captcha-solver code paths in `browser.js` produce those filenames,
all gated on real challenge DOM). The net engaged and survived.

Two things came out of that night:

1. **The multi-segment truncation it would have exposed is fixed.** The browser
   read loop used to break on the first answer-phase `finished`, silently cutting
   long tool-heavy turns short with a false `finish_reason: "stop"`. It now
   mirrors the direct loop's segment semantics (keep reading past `finished`,
   terminate on body-close), and `tests/fc_harvest.test.mjs` →
   `replay(stopOnFinished)` gates the behavior offline. The remaining known
   divergence: the browser path still locks onto the first content-bearing
   `response_id` instead of pre-scanning for multiplexed generations.
2. **Post-solve outcome is unlogged.** The proxy logs were stale by the time of
   inspection, so what the request did AFTER the captcha solve is unknowable.
   Worth one line of logging per fallback engagement (challenge detected →
   solved/failed → stream result) so the next live event leaves a trail.

Force it with `QWEN_DIRECT=0` and run `test_agent_loop.js`. The simple slider
solves in-process; only a puzzle captcha needs the optional `CAPTCHA_SOLVER_URL`
sidecar, which is not shipped here — so a puzzle upgrade ends the run.

---

## 3. The native `function_call` harvester is dormant, proven offline only

The three feature-config flags (`enable_tools` / `enable_function_call` /
`tool_choice: "none"`) silenced Qwen's native channel completely — post-patch
captures have 0 `function_call` frames. `makeFCHarvester` is belt-and-braces that
has never run on a live wire; if Qwen re-enables the channel it engages untested.

It *is* proven against the real 52-frame capture (`tests/fc_harvest.test.mjs` +
`tests/fixtures/sse_todowrite.jsonl`, part of `npm test`), including snapshot
semantics and multi-call flush. This is an accepted risk, listed so it isn't a
surprise.

---

## 4. Large `write` / `edit` bodies may truncate

Documented as a recurring production failure in a reference proxy
(`yelihua77-source_qwen2API/README.md:1086-1088`):

> 大文件 Edit / Write 报 JSON 解析失败 — 通常是上游输出被 `max_output_tokens` 截断

Ours is partially mitigated: `toolparse.js:106-110` attempts a repair on an
unterminated tail. Theirs is a whole `truncation_recovery.py` (detect → continue
→ dedupe). If big writes start failing, that is the file to read.

Not reproduced here yet — the agent loop's largest write is ~1 KB.

---

## 5. Deferred: tool-name obfuscation (Plan B)

A third, independent mitigation for `Tool X does not exists.`, from
`gloria-29_qwen2API-fixed/backend/services/tool_name_obfuscation.py`. Qwen's
upstream validates common short names (`Read`/`Write`/`Bash`/`Edit`) against its
own builtins. Renaming them (`Read` → `fs_open_file`, `Bash` → `shell_run`, plus a
blanket `u_` prefix) means upstream never recognizes them and the model falls back
to the XML channel we parse.

Costs: bidirectional name mapping, rewriting bare names inside prompt text, and
they needed few-shot injection to compensate for the model losing familiarity with
renamed tools. Reach for it only if native calls start arriving with unusable
payloads again.

---

## 6. Smaller items

- **TAP granularity of the harvest suite.** `tests/fc_harvest.test.mjs` uses bare
  top-level asserts (no `test()` wrappers), so `node --test` reports it as ONE
  test covering four scenarios. A regression still fails the run, but the TAP
  line won't say which suite broke — read stderr. Wrap in `test()` blocks if
  granularity ever matters more than the churn.
- **Watch: timer aborts misclassify as WAF (exposure opened by the A2 port).**
  Pre-A2 the browser loop broke seconds in, so the in-page 600s abort timer and
  the 120s-idle watchdog were unreachable on healthy streams; now the loop runs
  until body-close and both are live. Either abort surfaces as `AbortError` →
  `{ok:false, challenge:true, error:"WAF_ABORT"}` → a good answer retried as a
  WAF challenge, silently. Empirically bodies do close (the direct path does
  `await res.text()` on the same upstream and terminates), so this should not
  fire — but fallback engagement is unlogged (see §2), so it would be invisible
  if it started. Mitigation if ever observed: distinguish a timer abort from an
  `abortCurrentFetch` abort (separate rejection path) so timeouts return
  `{ok:false, error:"timeout"}` instead of `challenge:true`. Watch item.
- **Turn-label injection stripping.** The collapse format writes `User:` /
  `Assistant:` prefixes into one prompt. A message containing those literals can
  forge a turn boundary. The Syde reference has `stripTurnLabels` in
  `lib/conversation.ts`. Low risk single-user, real for anything multi-tenant.
- **Full streaming ToolStream state machine.** Handling bare JSON and
  code-fenced tool calls mid-stream, not just `<tool_call>` XML. The
  non-streaming extractor already tolerates more shapes than the streaming one.
- **`encryptarun_qwen-api` (57★) not yet mined.** Only unread reference clone.
- **`sse_tui_run.jsonl` is 545 KB (repo root).** Two fixtures were already
  carved out of it and now live in `tests/fixtures/` (`sse_multigen.jsonl`,
  `sse_multisegment.jsonl`). Keep or recycle once nothing else needs mining
  from it.
- **`memory_pre_history_fix.json` (88 KB)** is a pre-fix snapshot, now
  gitignored. Recycle when the stateful-client fix is settled.

---

## 7. From the external review, 2026-08-24 — real, not fixed

Eight findings from that review were fixed the same day (token identity in
`finalize`, body cap, loopback bind, memory wipe on `/v1/conversations` DELETE,
the `solveCaptchaCVInFrame` arity bug, the farmer hint in `chat.js`, the SSRF
block in `upload.js`, `videoJobs` eviction). The ones below survived verification
but were deliberately left out. What the review got *wrong* is recorded in
[README.md](README.md#what-an-external-static-review-caught-and-what-it-got-wrong)
so the next reviewer doesn't re-run into the same walls.

**`unhandledRejection` kills the process (`server.js:2971`).** One stray
rejection anywhere takes down every in-flight stream. It matches Node's own
default and it does close the browser first, so it is deliberate — and every
async function in `server.js` is either awaited or `.catch()`ed (checked, zero
unawaited calls), so nothing currently reaches it. Left alone: with no fire-and-
forget callers to guard, changing it would only make a real bug quieter.

**`store.js:17` is synchronous.** `readAll()` does `fs.readFileSync` on every
`getHistory`/`saveHistory`, so each request blocks the event loop for the length
of a `memory.json` parse. Irrelevant single-user, wrong at any concurrency.

**Token estimation under-counts CJK (`anthropic.js:6`).** `chars / 3` is about
right for English and roughly half the true count for Chinese (Qwen is ~1 token
per CJK char). It only drives the `QWEN_MAX_CONTEXT` truncation decision, and the
error direction means truncation fires too *late* — the prompt gets cut upstream
instead of locally, which is the failure mode that actually loses data. A
per-script multiplier would close it; a real tokenizer is overkill.

**Uniform WebGL fingerprint (`ssxmod.js:30`).** `DEFAULT_TEMPLATE` hardcodes
`NVIDIA GeForce RTX 3080`, so every direct request from every deployment reports
the same GPU. Harmless until Alibaba correlates device identity across accounts,
at which point it is a very loud signal. Randomize per token.

**Two `.substr()` calls**, `server.js:2407` and `:2704`. Annex B legacy,
`.slice()` is the drop-in. Works fine; cosmetic.

### Rejected: splitting `handleChatCompletions`

The review's headline recommendation was to break up `server.js` and extract
`handleStreamingCompletion` / `handleNonStreamingCompletion` from the ~570-line
handler. Declined, and worth not re-litigating:

The two paths look duplicated but genuinely diverge — one consumes `onDelta`
incrementally and has to carry `toolBuffer` / `toolCallIndex` / restart-phase
state across attempts, the other buffers the whole body and re-parses it. Every
subtle bug found across five rounds of debugging lived in exactly that
difference, and the fixture-backed tests pin down the retry/resume/finalize dance
wrapped around them. The refactor buys readability and risks the one part of this
codebase with hard-won coverage. Revisit when there's a failing test the current
shape makes impossible to write.

---

## 8. In-Chat Video & Remaining Polish Items (Post-Layer B)

Recorded from the in-chat video generation integration (2026-08-25):

1. **`opencode.json` client configuration:**
   - Change `baseUrl` from `http://localhost:8787` to `http://127.0.0.1:8787` to bypass Node DNS lookup delays on Windows.
   - Set an explicit client timeout (`timeout: 300000` / 5 min) so OpenCode doesn't drop connections during long upstream video renders (Wan 2.1 renders routinely take 60–180s).

2. **F7 structured retryable-error detection:**
   - Extend structured upstream retry classification across all media endpoints (image generation, image editing, video tasks) to catch intermittent Alibaba WAF / rate-limit glitches consistently.

3. **Plain-chat awareness line (Zero-tool chats):**
   - Currently, capability awareness is injected when tools are active. For tool-less plain chats, the awareness line is withheld to preserve the bare-single-turn fast path (`server.js:802`) and prevent collapsing turns into `User:` / `Assistant:` format.
   - Tool-less clients select `wan3.0-video` in the model picker instead. Revisit if full conversational awareness in plain chats is desired without latency penalty.

4. **Browser-fallback probe (Plan step 4):**
   - Offline tests cover the browser loop semantics (`tests/fc_harvest.test.mjs`), but an active live probe with `QWEN_DIRECT=0` was deferred to save daily user quota and avoid unassisted puzzle captcha challenges.

## 9. Web search on a tools-on turn — capability gap, closed 2026-08-25

Found 2026-08-25 while diagnosing a blank opencode turn. **The blank turn itself
was three separate bugs, all now fixed** — see
[README](README.md#an-unparseable-tool_call-block-is-prose-not-silence):

1. a closed `<tool_call>` that parsed to zero calls was discarded by the
   streaming path,
2. a block the model never closed (`</parameter></function>` instead of
   `</tool_call>`) was withheld and then skipped by a flush gated on
   `!inToolCall` — `leftoverText` now flushes it with its opening tag,
3. three missing entries in the tag-prefix list meant an SSE frame boundary
   inside `<tool_call>` leaked the fragment and killed the call — now
   `PARTIAL_TOOL_TAGS`, swept at every frame boundary by
   `tests/fc_harvest.test.mjs`.

The real gap behind it: the model had no search of any kind on a tools-on turn,
invented Qwen's own `web_search`, and — after fix 1 above — rendered that attempt
as text.

**[Experiment A](README.md#experiment-a-auto_search-is-safe-the-prompt-shape-is-the-suppressor)
settled the cheap option: there isn't one.** `auto_search: true` is safe next to
the kill flags (tool parsing is unaffected) but it changes nothing, because search
fires on the bare single-turn fast path and a tools-on turn collapses history into
`User:` / `Assistant:` form. The suppressor is the prompt shape, not the flag.
Don't re-run it.

**Shipped 2026-08-25** — `websearch.js` + the interception in `server.js`, live
verified. Full write-up in
[README](README.md#in-chat-web-search-a-second-isolated-chat); what was built:

1. **Backend: an isolated Qwen chat.** `runWebSearch` (`server.js:1952`) asks the
   query as a bare, tool-less, one-turn message, so the kill flags never fire and
   the request lands on the fast path A3 searched on. Zero new dependencies —
   surveyed all 12 reference proxies and not one implements its own search
   backend; every one only toggles Qwen's `auto_search`.
2. **Budget: one search per turn**, `takeFirstSearch` (`server.js:2008`), extras
   logged as dropped. Wall clock is `QWEN_SEARCH_TIMEOUT_MS` (default 120000),
   raced against the completion and wired to `abortRef.abort` so it cancels the
   fetch instead of orphaning it. Generous on purpose: the local TLS handshake
   runs 4–12 s machine-wide (§1) and a search may take the browser fallback.
3. **Registry: `SEARCH_TOOL` injected into `body.tools`** next to `VIDEO_TOOL`
   (`server.js:2177`) — prompt *and* registry, or the call is discarded as prose.
   Injection is skipped when a client already declared the name (matched through
   `normalizeName`, so `webSearch` collides). Qwen's own `queries` array is read
   by `searchQueryOf`, along with `q`/`search_query` and a bare string.
4. **Retry: `pendingSearchCalls` is in the empty-completion guard**
   (`server.js:2494`), so a turn that is nothing but a held-back search is not
   retried as a degraded upstream.

Two things fixed on the way: the isolated chat's own `<tool_call>` narration (the
A3 artifact) is stripped by `buildSearchContent`, and both post-turn loops now
leave `finish_reason` alone once a *client* tool call went out — the old
unconditional `"stop"` told the client the turn was over and its tool never ran.
That one was live in the video path too.

Live: 47.7 s for a search turn (`finish=stop`, 624 b of real prices with `[[3]]`
markers) against 13.2 s for a plain `write` call. Guarded offline by
`tests/websearch.test.mjs` (6 tests, mutation-checked).

**Left open, both model-side:** asked for a price *and* today's date it searched
the price only, and two upstream turns with thinking on is 45–75 s — a fast-mode
search chat would cut it, at the cost of a worse answer. Neither is a proxy bug.

The rejected alternatives, kept so they aren't re-proposed: a prompt line telling
the model it has no search (near-free, adds no capability), and doing nothing
(opencode's `webfetch` on a search-engine URL works, and the model reaches for it
unprompted about half the time).

---

## 10. Web UI Menu Survey & Scope Decisions (Surveyed 2026-08-26)

Full survey of all capabilities presented in the official `chat.qwen.ai` tool menu:

| Web UI Item | Status in Proxy | Technical Classification & Decision Rationale |
| :--- | :---: | :--- |
| **Upload attachment** | **Shipped** | Full vision/file upload support via `upload.js` + Alibaba `/api/v1/files/`. |
| **Create Image** | **Shipped** | Full Text-to-Image and Image-to-Image editing via `/v1/images/*` and inline chat CDN rendering. |
| **Create Video** | **Shipped** | Native Wan 2.1 engine integration via `/v1/videos/generations`, model `wan3.0-video`, and `generate_video` tool. |
| **Web search** | **Shipped** | Isolated sub-chat execution via `websearch.js`, domain links (`[espn.com](url)`), and sources footer. |
| **Deep Research** | **Deliberately Excluded** | Multi-step 10–15 minute long-form essay scraping pipeline. In coding agents (OpenCode), the agent *is* the researcher (using multi-turn `grep`/`glob`/`read`/`web_search` loops). Exposing a monolithic 15-minute blocking call freezes coding IDEs and breaks request timeouts. |
| **Web Dev / Artifacts** | **Shipped** | Direct extraction in `artifacts.js` (`qwen_mode === "web_dev"`). In OpenCode, artifact generation is native. |
| **Slides / Learn / Travel Planner** | **Deliberately Excluded** | Pure frontend prompt templates in Alibaba's React UI (pre-filling system prompts like *"You are a presentation maker..."*). They have no distinct backend models or APIs. Client system prompts control formatting directly. |
| **Tools Toggle** | **Shipped** | Emulated OpenAI/Anthropic function calling with auto-suppression of internal Alibaba plugin leaks. |

---

## 11. Codebase Audit, Dead-Code Purge & Hardening (SHIPPED 2026-08-26)

Full structural cleanup and hardening pass following an independent codebase audit:

1. **Held-Back Execution Abort Guards:**
   - Both `pendingSearchCalls` and `pendingVideoCalls` loops guarded against `abortRef.aborted` / `res.writableEnded`.
   - `generateVideo` polling loop checks abort status per iteration, killing 20-minute browser polling instantly if a client disconnects.
2. **Citation Scheme Sanitization:**
   - Added `isValidHttpUrl` in `websearch.js` to ensure citations only link to `http:` or `https:`.
3. **Tri-State Reasoning Effort:**
   - Full tri-state mapping: fast (`reasoning_effort: "none"|"low"`), auto (`reasoning_effort: "medium"|"auto"`), and thinking (`reasoning_effort: "high"|"max"`).
4. **HTML5 `<video>` Native Fallback:**
   - Consolidated video markup to `<video controls="controls" src="URL"><a href="URL">Download Video</a></video>` eliminating redundant visible download text in HTML-capable clients.
5. **Zero-Dependency Native Uploads:**
   - Replaced `formidable` with Node 22 native `new Response(Readable.toWeb(req)).formData()` for multipart handling in `/v1/images/edits` and `/v1/upload`.
6. **Codebase Purge (~3,850 lines / ~19 MB debris):**
   - Recycled dead folders: `backups/`, `src/`, `scripts/`, `generated/`.
   - Recycled 13 scratch test files from `tests/`.
   - Pruned dead artifact subsystem from `artifacts.js` / `server.js` and dead `deep_research` branches.
   - All 57 unit tests passing (207ms).



