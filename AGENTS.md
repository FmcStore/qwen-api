# AGENTS.md

Pointer file. The real documentation is [README.md](README.md) and
[TODO.md](TODO.md) — this exists so you load the right things in the right order
instead of grepping your way in.

## Read this first, in this order

1. **[README.md](README.md#findings-and-caveats) → "Findings and caveats."** Not
   optional. Every rule in that section was paid for with a broken agent run, and
   the SSE parse loop and tool-call path both look wrong until you have read why
   they are that shape. Start there if you are touching either.
2. **[TODO.md](TODO.md).** Open work, ordered. Everything deferred is deferred on
   purpose with the reasoning attached, including one rejected refactor — read the
   rejection before proposing it again.

## Six traps that have already cost debugging sessions

- **Never `node server.js`.** Always `npm start` (`node --env-file=.env server.js`).
  Plain `node` silently ignores `.env`, every flag falls back to its default, and
  no debug capture happens. Symptom: banner prints `Forget memories: true` while
  `.env` says `false`.
- **Redirect logs with `>>`, never `>`.**

  ```powershell
  node --env-file=.env server.js >> proxy_stdout.log 2>> proxy_stderr.log
  ```

  A truncating `>` erases the log of the run you are about to explain. Already
  cost one post-mortem: the stdout that would have timed a client hang-up was
  overwritten by the restart that shipped the fix for it.
- **Check `tokens` before blaming code.** `curl -s http://127.0.0.1:8787/health`
  → if `tokens` is `0` the pool is empty and nothing will work. Start the farmer:
  `py farmer/daemon.py`.
- **A stale listener will answer for you.** `EADDRINUSE` on 8787 means an old
  server is serving your requests and your changes are invisible. On Windows:

  ```powershell
  Stop-Process -Id (Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess -Force
  ```

  Piping the `NetTCPConnection` object straight into `Stop-Process -Force` binds
  no parameter and kills nothing — it fails silently. Extract `OwningProcess`.
- **A client "rate limit / anti-bot" banner is not proof of a WAF challenge.**
  Read `proxy_stderr.log` first. A real challenge logs
  `direct completion failed (…) — falling back to browser` and launches Chrome
  (`[browser] Chrome ready …`). Without those lines the 5xx came from somewhere
  else — an unparseable request body used to surface here as
  `TypeError: Cannot read properties of null (reading 'messages')` and a 500 that
  clients happily retried four times. Bad bodies now return 400 with the length
  and first 200 bytes logged.
- **A blank turn is a swallowed tool call, not an empty upstream.** No
  `Empty completion` line in `proxy_stderr.log` means the retry never fired,
  which means `content` was *not* empty — so something ate it on the way out. The
  streaming path used to discard any `<tool_call>` block that parsed to zero
  calls (unknown tool name; the registry is the only gate). It now re-emits the
  block as text. Reads exactly like "the model refused / fired no tools", which
  sends you hunting a capability regression that isn't there.

  There were **three** such swallow paths, all closed and all gated by
  `tests/fc_harvest.test.mjs`: the zero-parse block above, a block the model never
  closed (it wrote `</parameter></function>`, so the flush skipped it —
  `leftoverText`), and an SSE frame boundary landing inside `<tool_call>` (three
  tag prefixes were missing from the hold list — `PARTIAL_TOOL_TAGS`). Both
  helpers live in `toolparse.js` so the tests exercise the shipped code, not a
  copy of it. If a fourth appears, the pattern is the same: the buffer holds text
  the client never received.

## Verify before claiming done

```bash
node --check server.js && node --check toolparse.js && node --check browser.js && node --check video.js && node --check websearch.js
npm test
```

`npm test` is the offline tier (`node --test tests/*.test.mjs`) — it includes the
harvest replay suite (`tests/fc_harvest.test.mjs` + `tests/fixtures/`), the
worker-pool unit tests, `tests/video_task_ids.test.mjs`,
`tests/websearch.test.mjs`, and `tests/upload_ssrf.test.mjs`. Two suites are LIVE
and sit outside it at the repo root:
`test_agent_loop.js` (burns real quota) and `test_client_thread.js` (needs the
proxy up plus `QWEN_DEBUG=1`). Do not run either casually. Full breakdown in
[README.md](README.md#tests).

## Upstream is reverse-engineered

There is no official API behind this. `chat.qwen.ai` changes without notice, so a
break is as likely to be upstream as it is to be your diff. Before deep-diving a
new failure, check whether `QWEN_CLIENT_VERSION` has gone stale (WAF rejects old
ones) and read
[what a previous external review got wrong](README.md#what-an-external-static-review-caught-and-what-it-got-wrong)
so you don't re-walk those walls.

## Keep the docs true

Both docs cite `file.js:NNN` anchors. Any insert shifts them. If you add or remove
lines, re-derive the affected anchors from the source rather than assuming a
uniform offset — some have been stale before, so blind arithmetic propagates the
error. Update README/TODO in the same change as the code, not after.
