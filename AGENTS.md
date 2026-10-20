# Collab load testing agent guide

This standalone repository owns the demo server, browser client, Playwright load
generator, observer, and reports. Read `README.md` before running or changing the
harness. Check `npm run load-test -- --help` for flags available in the current
checkout; local investigation tooling may be ahead of committed source.

## Measurement rules

- Distinguish typing writers, passive browser readers, and backend service
  connections. Ten writers plus an observer means eleven browser participants;
  the backend document service can add another WebSocket connection.
- Local latency starts at browser keydown and ends when the expected text prefix
  is detected in rendered DOM. Remote latency uses the same writer keydown and
  detection in the observer. Neither measures physical display paint.
- Report dispatch-to-keydown delay separately. Include requested and achieved
  typing rates, observed/missing samples, clock uncertainty, and final-text
  matches. A correctness pass does not mean the requested load was sustained.
- Match transport messages by exact update hash. A matched-update subset is not
  a per-keystroke breakdown; do not subtract its averages from visibility means.
- Separate processes or containers on one host still share CPU and memory.
  Profiling, trace collection, Playwright, and probes can affect the result.
- Retain timed-out/partial runs and missing observations. Never replace them
  silently with a successful repeat or treat missing arrivals as zero latency.
- Record the exact engine version, source commit, build profile, served artifact
  identity, backend version/configuration, and trial flags. A local source build
  without release protection is not a controlled comparison to a protected
  published build.
- Keep documents, generated DOCX files, screenshots, traces, private engine
  bundles, and extracted customer content under ignored local artifacts. Do not
  commit them or loosen `.gitignore` to publish them.

## Latest investigation: 2026-10-20

The latest analyzed browser engine was SuperDoc **2.25.0-next.20**, docx-engine
**0.24.0-next.20**, built from Orbit main
`7b77c7b35878b1c4ee462c2af78eee9d05346a5d`. The harness backend retained its
installed published server stack. These findings describe that captured setup,
not every future release or deployment.

### Ten simultaneous writers on page one

Each writer typed `the quick fox jumped over the lazy dog` once, with a passive
observer. Requested rate: five characters/second/writer. A repeat with a
180-second timeout passed with 380/380 local and 380/380 observer observations,
all final text matching. Actual input rate was about **2.6 characters/second**
per writer. The edit-through-convergence duration was 20.1 seconds.

| Measurement | Mean | P95 |
| --- | ---: | ---: |
| Keydown to local DOM visibility | 421 ms | 813 ms |
| Keydown to observer DOM visibility | 878 ms | 2,686 ms |
| Runner dispatch to browser keydown | 266 ms | 796 ms |

The first attempt exceeded its 67.6-second typing deadline. All characters
eventually appeared during cleanup, but that result remains failed/partial.
The repeat changed the timeout allowance, not the requested input rate or
profiling. The large run-to-run difference is unexplained; retain both results.

### Findings and confidence

1. **Document-worker queueing is the strongest observed local bottleneck.**
   During the 17.3-second first-keydown-to-last-observer-text trace window,
   writer U01's document worker occupied 15.8 seconds of task wall time, with
   91 tasks lasting at least 50 ms. Its main thread occupied 2.4 seconds.
   Worker thread execution was only 6.3 seconds: the wall/thread gap is consistent
   with off-CPU scheduling or waits, but does not prove their cause.
2. **Presence-message echo is confirmed extra work.** Of 3,678 incoming
   awareness frames, 3,366 (91.5%) repeated an identical payload previously sent
   by the server to that same connection. The resolved Hocuspocus provider's
   awareness handler sends remote-origin updates back; the server broadcasts
   changed awareness to every connection. This is bounded echo/fan-out evidence,
   not proof of an infinite loop or a measured share of total latency.
3. **Formatting/style compilation is a strong engine hotspot.** Writer-worker
   samples repeatedly hit `compileWordStyleModel` from the effective-formatting
   reader used for toolbar state. This was absent from the previous single-writer
   samples. Investigate why the existing style cache misses during concurrent
   body edits; the cache-miss reason was not captured. Render-source lifetime
   cleanup through `releaseSourceInput` and `AbortController.abort` is another
   prominent sampled path. Neither is review-worker reinitialization.
4. **Demo and measurement overhead contribute pressure.** The demo issued
   391 room-status POSTs, with activity wired to every transaction. Generator
   event-loop stalls reached 714 ms; server stalls reached 1.08 seconds. Heavy
   browser tracing, protocol dispatch, logging, and garbage collection compete
   on the same machine. DOM scanning itself was relatively small in the trace;
   that does not make all observer/profiling overhead negligible.

For 19 exactly matched U01 updates, browser-send to server-receipt averaged
408 ms, server receipt to observer-send enqueue 22 ms, and enqueue to observer
socket receipt 5 ms. These boundaries include queueing and cover a subset of
updates. The final network hop was not the dominant delay in that subset.
Backend Yjs transactions had a 0.295 ms P95; broadcast/listener enqueue work had
an 80 ms P95, with occasional larger stalls.

**Review-worker reinitialization was absent:** zero separate review-worker
creations or terminations, with one document worker per browser client. Current
Orbit main already removed the older separate review-worker path observed in
published 2.18.0. Do not reapply a historical fix or claim this investigation
changed production engine behavior. Review computation inside a document worker
is not ruled out merely by the absence of separate workers.

### Next steps and evidence

Prioritize remote-origin awareness echo, investigate formatting-cache misses and
render-source cleanup, then debounce demo activity POSTs and isolate/lighten the
measurement roles. Do not implement a production fix for an investigation-only
request. Existing evidence is enough to identify these leads; use a targeted
before/after experiment to quantify a proposed fix rather than repeating broad
trials without a hypothesis. CPU sample counts are not invocation counts or
exclusive operation durations, and overlapping categories must not be added.

Local evidence is intentionally ignored and may not exist in a fresh clone:

- `artifacts/orbit-review-fix-2026-10-20/ten-writers-next20-complete/`:
  `report.html`, `slowdown-findings.md`, `slowdown-findings.html`,
  `slowdown-analysis.json`, `analyze-run.py`, `source-evidence.json`, and original
  profiles/timelines. The analysis script reads saved evidence without running
  another workload. Both completed Chrome timelines reported no data loss.
- `artifacts/orbit-review-fix-2026-10-20/ten-writers-next20/`: initial timeout;
  its writer timeline reported data loss.
- `artifacts/orbit-review-fix-2026-10-20/latest-next20/`: preceding single-writer,
  nine-reader trial with the same browser engine build.
