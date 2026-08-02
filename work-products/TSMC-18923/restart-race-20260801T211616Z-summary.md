# Canonical-port restart-race proof

**Result: PASS** — controlled restart race on the served Paperclip tree reclaimed the requested canonical port `3100` after a temporary listener released it.

## Evidence

- Served source: `/Users/glad0s/paperclip`
- Served HEAD at execution: `7439bc49747bb6fd3b3615c37bc195447c985f56`
- Fix commit `eda7c53dc` is an ancestor of that served HEAD (`git merge-base --is-ancestor eda7c53dc HEAD` exited `0`).
- The server log records both required lifecycle events:
  - `Requested port 3100 is busy; waiting up to 30000ms for it to free (usually the outgoing process during a restart).`
  - `Requested port 3100 became available; binding it.`
- Health captured after binding: `restart-race-20260801T211616Z-health.json` reports `status: "ok"`, `instance.commit: "7439bc497"`, and the server banner reports `Server 3100`.

## Method and cleanup

The harness booted out the managed source service, bound a temporary local holder to `:3100`, launched the served tree's `server/src/index.ts` with `PORT=3100` and `PAPERCLIP_PORT_WAIT_MS=30000`, then released the holder. The direct process and holder were terminated and the managed service restored unconditionally.

The requested `eda7c53dc` is no longer the exact served HEAD; the test therefore proves its canonical-port logic as inherited by served commit `7439bc497`, rather than misreporting the latter as `eda7c53dc`.
