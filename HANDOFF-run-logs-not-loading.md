# Handoff → runtime session: run transcripts not loading ("Run log not found")

**From:** design/UI session · **Date:** 2026-06-09 · **Priority:** HIGH — the entire run-stream view is empty for completed (and live) runs. Breaks transcript UX + blocks the thinking-cursor verification.

## TL;DR
On `os.valadrien.dev`, opening any agent run shows **`Transcript (0)` → "Waiting for transcript…" → "Run log not found."** even though the run clearly executed and produced output (token counts + cost + a result summary are all present on the run). The transcript log itself never resolves. This is almost certainly a **storage / log-persistence** issue (likely fallout from the object-storage provider switch), not the transcript UI — the UI renders fine when given a log.

## Evidence (live, authed as cofounder@valadrien.dev)
- Korije run `821575ff` (and `276475a2` before it): run header shows `succeeded`, model, `Input 4 / Output 232`, `Cost $0.2941`, `Duration 17s` — i.e. the run record + metrics loaded fine. But the transcript panel shows **`Transcript (0)`**, **"Waiting for transcript…"**, and a clay **"Run log not found"** banner.
- Korije's runs list shows substantial prior work (VAL-11 … VAL-16, 800–15,200 tokens each) — so logs *should* exist for those runs.
- Same on a second run viewed ~minutes apart, and on a fresh cold-boot load. Not a one-off.

## Why this matters
1. **Users can't see what an agent did.** The run-stream / transcript is the primary "watch the agent work" surface; right now it's empty for every run I opened.
2. **It blocks the new thinking-cursor.** I shipped the GLASSHOUSE thinking cursor (`components/ThinkingCursor.tsx`, wired into `components/transcript/RunTranscriptView.tsx` — it renders at the end of a streaming assistant block, replacing the old "Streaming" badge). It is correct by construction and build-verified, but it **lives inside the transcript** — if the transcript log never loads, the cursor can never render, regardless of run timing. So this run-log issue is the one thing standing between "shipped" and "visibly working."

## Likely area to check (runtime/storage lane — not mine)
- The run-log fetch path: whatever endpoint backs the transcript (`Run log not found` is the not-found branch). Confirm it's reading from the **same storage provider** the runs are written to. The recent `VALADRIEN_OS_STORAGE_PROVIDER=s3` (Supabase Storage) switch + the `local_disk can't persist on Vercel serverless` note (your own health commit) are the prime suspects: if logs are **written by the Railway worker** to one location but **read by the Vercel control plane** from another (or local_disk that doesn't persist), the read 404s → "Run log not found."
- Check whether logs are being written at all for new runs, and whether the read path is company/run-scoped correctly.
- Cross-ref #7785 (cold boot): the cold-boot latency separately makes fast runs finish before the transcript page even loads — but that's secondary; the primary bug here is the log simply not being found.

## Repro
1. Open any agent → Runs → a completed run (e.g. one of Korije's VAL-1x runs).
2. Observe: run header/metrics load, but transcript = `Transcript (0)` + "Run log not found."

## Design side — nothing blocked on me
The thinking cursor + the rest of the signature set (animated eyes, framed `AgentPortrait`, `HeartbeatSpine` on the roster + org chart, live `CostTape`) are shipped and verified live. The cursor will render the moment a transcript log actually loads. Ping me once run logs resolve and I'll confirm the cursor on a live streaming run.

— design/UI session
