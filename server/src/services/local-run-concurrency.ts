import {
  DEFAULT_LOCAL_MODEL_PROVIDERS,
  DEFAULT_MAX_CONCURRENT_LOCAL_RUNS,
  DEFAULT_MAX_DISTINCT_LOCAL_MODELS,
} from "@paperclipai/shared";

/**
 * Global, cross-agent concurrency caps for local (Ollama-backed) agent chats.
 *
 * Why this exists: the per-agent `runtimeConfig.heartbeat.maxConcurrentRuns`
 * knob only bounds a single agent. With several local agents eligible at once,
 * nothing stopped the instance from launching many simultaneous `opencode_local`
 * chats and forcing the Ollama host to load more models than its VRAM allows.
 * These caps are enforced centrally in the run scheduler
 * (`startNextQueuedRunForAgent`) so the whole instance respects a single budget.
 *
 * Scope: only `opencode_local` runs whose model provider is local/Ollama-backed
 * (see {@link LocalRunCaps.localModelProviders}) count against the caps.
 * Cloud-backed `opencode_local` agents (e.g. `github-copilot/...`) are exempt
 * because they do not occupy an Ollama chat slot or load an Ollama model.
 */
export interface LocalRunCaps {
  /** Max concurrent running local chats across the whole instance. */
  maxConcurrentRuns: number;
  /** Max distinct local models loaded simultaneously across the instance. */
  maxDistinctModels: number;
  /** Model providers treated as local/Ollama-backed (lower-cased). */
  localModelProviders: string[];
}

/** Adapter type whose runs are subject to the local-run caps. */
export const LOCAL_RUN_ADAPTER_TYPE = "opencode_local";

function clampPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseProviderList(raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw == null) return [...fallback];
  const items = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return items.length > 0 ? items : [...fallback];
}

/**
 * Resolve the local-run caps from the environment, falling back to the shared
 * defaults. Read from a process-wide source (env) rather than a per-instance
 * factory option so that every `heartbeatService` instance in the process
 * (routes construct their own) agrees on the same global budget.
 */
export function resolveLocalRunCaps(env: NodeJS.ProcessEnv = process.env): LocalRunCaps {
  return {
    maxConcurrentRuns: clampPositiveInt(
      env.PAPERCLIP_MAX_CONCURRENT_LOCAL_RUNS,
      DEFAULT_MAX_CONCURRENT_LOCAL_RUNS,
    ),
    maxDistinctModels: clampPositiveInt(
      env.PAPERCLIP_MAX_DISTINCT_LOCAL_MODELS,
      DEFAULT_MAX_DISTINCT_LOCAL_MODELS,
    ),
    localModelProviders: parseProviderList(
      env.PAPERCLIP_LOCAL_MODEL_PROVIDERS,
      DEFAULT_LOCAL_MODEL_PROVIDERS,
    ),
  };
}

/**
 * Extract the provider segment from an `opencode_local` model id such as
 * `dev/qwen3.6:35b` (-> `dev`) or `github-copilot/claude-opus` (-> `github-copilot`).
 * Returns null when there is no provider prefix.
 */
export function parseModelProvider(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const provider = model.slice(0, slash).trim().toLowerCase();
  return provider.length > 0 ? provider : null;
}

/**
 * Whether a run for the given adapter type + model should be counted against
 * the local-run caps (i.e. it is an Ollama-backed `opencode_local` chat).
 */
export function isLocalModelRun(
  adapterType: string | null | undefined,
  model: string | null | undefined,
  caps: Pick<LocalRunCaps, "localModelProviders">,
): boolean {
  if (adapterType !== LOCAL_RUN_ADAPTER_TYPE) return false;
  const provider = parseModelProvider(model);
  if (!provider) return false;
  return caps.localModelProviders.includes(provider);
}

/** Snapshot of currently-running local chats across the instance. */
export interface LocalRunState {
  /** Count of running local chats. */
  runningCount: number;
  /** Distinct local models currently loaded by running chats. */
  loadedModels: Set<string>;
}

/**
 * Compute how many additional runs may be admitted for a local agent without
 * breaching the global concurrency cap or the distinct-model ceiling.
 *
 * - Concurrency: bounded by `maxConcurrentRuns - runningCount` and by the
 *   per-agent slots already computed by the caller.
 * - Model ceiling: if admitting this agent would load a model that is not
 *   already loaded and the distinct-model ceiling is already reached, no run is
 *   admitted (the agent stays queued until a model slot frees up). Admitting an
 *   already-loaded model never adds a new distinct model, so it is unaffected.
 *
 * All of the runs being admitted in a single call belong to one agent and thus
 * share one model, so the model check is evaluated once for the agent.
 */
export function computeLocalRunAdmissionSlots(args: {
  state: LocalRunState;
  agentModel: string | null | undefined;
  perAgentSlots: number;
  caps: LocalRunCaps;
}): number {
  const { state, agentModel, perAgentSlots, caps } = args;
  const concurrencySlots = Math.max(0, caps.maxConcurrentRuns - state.runningCount);
  const slots = Math.min(Math.max(0, perAgentSlots), concurrencySlots);
  if (slots <= 0) return 0;

  if (agentModel) {
    const alreadyLoaded = state.loadedModels.has(agentModel);
    if (!alreadyLoaded && state.loadedModels.size >= caps.maxDistinctModels) {
      return 0;
    }
  }
  return slots;
}

/**
 * Process-wide async mutex that serializes the local-run admission decision
 * (read global state -> claim runs). Without it, two different local agents
 * could pass the cap check simultaneously and both start runs, over-admitting
 * past the cap (the per-agent start lock only serializes a single agent).
 */
let admissionChain: Promise<void> = Promise.resolve();
export async function withLocalRunAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = admissionChain;
  let release!: () => void;
  admissionChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
  }
}
