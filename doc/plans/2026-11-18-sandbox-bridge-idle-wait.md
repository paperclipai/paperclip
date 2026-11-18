# Sandbox file bridge: wait in the pod instead of polling from the server (TECH-9007)

## Problem

A Kubernetes sandbox run uses the file-queue bridge (`queue_v1`), because the
Kubernetes driver does not declare `duplexCommandStream`. For the whole run the
server:

- lists the pod's request queue with one pod exec, sleeps 100 ms, and repeats
  (`sandbox-callback-bridge.ts`, poll loop in `startSandboxCallbackBridgeWorker`);
- tails the run log files with one pod exec every 250 ms
  (`sandbox-run-log-stream.ts`).

Each exec is a JSON-RPC call from the server to the plugin worker plus a
Kubernetes exec WebSocket. The TECH-8174 load replay measured about 10 ms of
server main-thread CPU per exec (61% of a core at 62 exec/s with 10 runs; 109-129%
at 98 exec/s with 30 runs; the idle diagnostic gives the same ratio). An idle run
costs about 3 exec/s (the exec round trip plus the 100 ms and 250 ms sleeps), so
3-5% of a server core and about 2.5% of a worker core. At 30 concurrent runs the
server process is saturated, the bridge p95 is 3.16 s and run p50 is 66 s
(26.6 s at 5).

Almost all of that cost is polling an empty queue and unchanged log files.

## Options

Numbers are per concurrent run. "Idle" means no bridge request and no new log
output (the agent is thinking, sleeping, or waiting on the model).

| Option | Idle execs per run | Server CPU idle per run | Request latency while idle | Risk |
|---|---|---|---|---|
| Today | about 3/s (180/min) | 3-5% of a core | 100 ms poll + exec | n/a |
| (a1) Adaptive backoff only (100 ms while active, 1 s when idle) | about 1.5/s (90/min; logs at 250 ms still) | about 1.5% | up to 1 s plus exec: bursts after a pause pay 1 s | Low, but misses the latency goal after any pause and leaves half the cost |
| **(a2) Blocking wait in the pod (chosen)** | **about 0.4/s (24/min: one 5 s wait for the queue, one 5 s wait for the logs)** | **about 0.1-0.2%** | **50 ms in-pod check + exec return (about 60-150 ms)** | **Low: same transport, same files, same worker; only the listing exec waits** |
| (b) Batch several pods per exec | n/a | n/a | n/a | Not possible: a Kubernetes exec targets one container in one pod |
| (c) Move the poll loop off the main thread | unchanged | main thread freed, total CPU unchanged; the plugin worker still pays 2.5% per run | unchanged | High: the worker owns guards, spans, timers and handler callbacks that run on the main thread; a thread hop for each of them |
| (d) Event-driven duplex/HTTP-2 transport for Kubernetes | 0 | about 0 | lowest | High: the driver needs `duplexChannelOpen` over a long-lived exec stream (`execInPodStreaming` exists, but has no keepalive and loses its status frame on long execs, issue 4 in the TECH-8174 report); new in-pod transport for every Kubernetes run; route policies and the teardown drain are file-bridge only today |

### Why (a2)

- The in-pod gateway writes each request with an atomic rename into
  `requests/<id>.json`. The server-side listing exec can therefore wait in the
  pod: a small `sh` loop checks the directory every 50 ms (a builtin glob, one
  `sleep` fork) and exits as soon as a request file it is not already handling
  appears, or after the wait window. One exec per 5 s replaces about 15 (the
  100 ms sleep plus the exec round trip measured on dev).
- A request that arrives while the run is idle is seen within 50 ms by the pod
  loop, so latency is lower than today's 100 ms server poll, not higher. No
  wake signal or new gateway code is needed. `inotifywait` is not guaranteed in
  sandbox images, so the loop uses `sleep 0.05` (with a 1 s fallback when the
  image's `sleep` rejects fractions, so the loop can never spin).
- Nothing about request handling changes: the same files, the same per-request
  read/write/remove, the same guards, lanes, route policies (TECH-8907),
  watchdog and drain. Drivers keep the file transport.
- It is on by default for Kubernetes, with no config switch. It is gated on the
  provider, because the wait only helps when each control command is its own
  exec: Kubernetes opens one exec WebSocket per command. Cloudflare routes every
  bridge command to one named session, where a 5 s wait could hold up request
  reads and response writes, so Cloudflare and every other provider keep the
  list-and-sleep poll unchanged (`sandboxProviderSupportsBlockingBridgeWait`).
  A provider joins the set once its control commands are known to run
  independently. Pi, Claude and Hermes local runs do not use the sandbox bridge
  at all, so they are unchanged.

### Run-log tail

The same idea: the tail exec waits in the pod (checking every 200 ms) until the
stdout or stderr log grew past the byte offset the host already has, or the
status file appears (the command ended), or the wait window ends. For
Kubernetes the minimum spacing between ticks goes from 250 ms to 500 ms; other
providers keep the 250 ms poll with no wait. So an idle run does one tail
exec per 5 s, and a run that prints continuously does at most 2 per second
(4 today). Live log lines appear within about 0.5 s, as before within a few
hundred ms.

## Design details

- New optional queue-client method `waitForJsonFiles(dir, { waitMs, ignore })`.
  The command-managed client adds it when created with `waitInSandbox: true`
  (the execution target sets that for Kubernetes) and implements it with the
  pod loop; the result is the same sorted listing `listJsonFiles` returns. A client without it (the local
  file-system client, external clients, test doubles) keeps the old
  list-and-sleep loop.
- `ignore` carries the request files that already have an attempt (route
  policies run requests in the background, and their files stay in the queue
  until the response is written). Without it the wait would return at once and
  turn into a busy loop.
- Wait window: the worker asks for `min(5 s, iteration timeout / 2, watchdog
  timeout / 4)`, and the queue client caps that at half its own exec timeout.
  With the defaults that is 5 s. The wait exec gets the wait window plus the
  normal 10 s iteration timeout, so it has the same overhead budget as a plain
  listing, and a healthy wait (at most about 5 s) never nears the 20 s
  watchdog.
- Spin guard: if a wait returns with nothing actionable in under one poll
  interval, the loop sleeps one poll interval (the old behavior is the worst
  case).
- Stop: `stop()` wakes the loop at once. The pending wait exec is abandoned (it
  ends by itself within the window) and the drain runs exactly as before, with
  plain listings, so the TECH-8907 drain timing is unchanged.
- Exec failure: a failed or timed-out wait is the same transient poll failure as
  a failed listing today: exponential backoff from 100 ms up to 5 s, the first
  failure on the run trace, the watchdog as escalation. After a failure the
  loop probes with plain listings until one succeeds, then waits again, so the
  recovery and watchdog timing match the old loop.
- Run-log `finish`/`abort` wake the tail loop at once and drop the pending
  tick's result; `finish` already emits every byte past the streamed offset from
  the final batch, so nothing is lost or duplicated.

## Expected numbers (to be confirmed by the load replay)

- Idle run: 24 execs per minute instead of about 180, so about 0.1-0.2% of a
  server core and about 0.1% of a worker core.
- Active run: a bridge request still costs about 5 execs (wake, size, read,
  write, remove), as today. The TECH-8174 idle diagnostic (91% of a core for 30
  idle runs) against the real mix (109-129%) puts the request and API work at
  roughly 20-40% of a core at 30 concurrent runs.
- 30 concurrent, prod-shaped mix: server process about 30-50% of one core
  (goal: under 60%), plugin worker about 15-25% (goal: under 60%), exec rate
  about 20-40/s (98/s measured), bridge p95 back near the 5-concurrent figure
  (under 1 s), run p50 close to 26.6 s.
- If the replay shows request execs dominate, the next step is to fold the size
  and read into the wake exec and the request removal into the response write
  (5 execs per request to 2). Not done here, to keep this change to one concern.
