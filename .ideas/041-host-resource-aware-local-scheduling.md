# 041 — Host Resource-Aware Scheduling for Local Agents (Work-Hours Yield)

## Suggestion

Local agents are fundamentally different from cloud/API agents: they run on the operator's
**own physical machine** and contend for a finite, *shared* resource — CPU, RAM, and especially
GPU/VRAM — that the human also needs. The local LLM adapter (idea 008) makes this acute: running
two large local models at once can exhaust VRAM and OOM, saturate the GPU, and make the operator's
own machine unusable. Paperclip today has **no host-resource awareness at all** — a code scan
finds no CPU/GPU/VRAM/memory/load monitoring, and the only time-based control (Spend-Schedule,
idea 005) governs *concurrency caps and budget by clock time*, which is provider-agnostic and
hardware-blind. The Fleet Concurrency Governor (idea 001) counts *runs*, not whether the GPU can
actually fit another model.

Two distinct needs follow, both unmet:

- **Capacity:** don't start more local-inference agents than the hardware can physically handle.
- **Work-hours courtesy:** during the operator's working hours, the human's use of the machine
  comes first — heavy local agent work should defer to off-hours or to when the machine is idle,
  then ramp up.

Add **host resource-aware scheduling for local agents**: monitor the machine, admit local runs
against real capacity, and respect a work-hours profile that yields the machine to its owner.

## How it could be achieved

1. **Host resource probe.** Add a lightweight monitor (new capability — none exists today)
   sampling CPU load (`os.loadavg`/`os.cpus`), free/total memory (`os.freemem`/`os.totalmem`),
   and GPU/VRAM where available (e.g. `nvidia-smi`, or platform equivalents). Surface it via the
   same read-model path the dashboard already uses. `environment-probe.ts` is the natural home.
2. **Resource-based admission for local runs.** Extend the run-admission gate (idea 001's
   governor) with a *capacity* check that applies only to local execution targets
   (`environment-execution-target.ts` already distinguishes local vs remote): refuse/queue a
   local run when free VRAM/RAM/CPU headroom is below a threshold, rather than counting slots.
   This is the difference between "max 4 runs" and "as many runs as this GPU can actually hold."
3. **Per-model resource hints.** Let a local-LLM agent config declare an approximate footprint
   (model size / VRAM need) so admission can reason about fit before launch instead of
   discovering OOM at runtime.
4. **Work-hours profile (yield to the human).** A machine-level schedule: during the operator's
   defined work hours, cap local-agent resource usage (e.g. ≤30% GPU, low priority) so the human
   keeps a responsive machine; off-hours, lift the caps and let local agents use the box fully.
   This is the *physical-resource* sibling of clock-time quiet hours (idea 005), and the two
   should share one schedule UI with a clear precedence order.
5. **Reactive yield.** Beyond the schedule, react to live load: when host GPU/CPU spikes (the
   human starts a heavy task), pause or throttle local agents and resume when the machine goes
   idle — a "get out of the way" reflex. Pair with adaptive heartbeats (idea 035) so yielded
   agents back off cleanly instead of busy-retrying.
6. **Local-only scope.** All of this applies strictly to local execution targets; cloud/remote
   agents (whose "resource" is provider quota and dollars) keep using the budget/quota controls
   (ideas 002, 012, 019). Detecting the target is already possible in the execution-target layer.

## Perceived complexity

**Medium.** The scheduling/admission framework to hang this on largely exists (the proposed
governor in idea 001, the local-vs-remote execution-target distinction, the routine/schedule
system), so the new core is the **host resource probe**, which the codebase lacks entirely.
Cross-platform resource sampling is the fiddly part — CPU/RAM are easy and portable via Node's
`os` module; GPU/VRAM is vendor- and OS-specific (NVIDIA vs Apple Silicon vs AMD) and best
treated as best-effort with graceful degradation when unavailable. Per-model footprint hints are
approximate by nature and only need to be good enough to prevent obvious OOMs. Ship CPU/RAM-aware
admission + the work-hours yield profile first (portable, immediately useful), then add GPU/VRAM
awareness where the platform supports it.
