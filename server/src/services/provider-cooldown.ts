import fs from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CooldownState {
  until: Date;
  reason: string;
}

/** Options for creating a ProviderCooldownService. */
export interface ProviderCooldownOptions {
  /**
   * Optional path to a JSON file for persisting cooldown state across restarts.
   * When provided, active cooldowns are written to disk on mutation and reloaded
   * on startup so quota-exhausted routes are not retried after a server restart.
   */
  persistPath?: string;
}

export interface ProviderCooldownService {
  /**
   * Puts a route into a cooldown state for a specified duration.
   * If the route is already cooling down, the cooldown period is extended
   * if the new `until` date is later than the current one.
   *
   * @param routeKey - The model-level route identifier (e.g., pluginId for a specific adapter/model).
   * @param durationMs - The duration of the cooldown in milliseconds.
   * @param reason - The reason for the cooldown (e.g., "rate_limit_exceeded").
   */
  setCooldown(routeKey: string, durationMs: number, reason: string): void;

  /**
   * Checks if a route is currently in a cooldown state.
   *
   * @param routeKey - The model-level route identifier.
   * @returns `true` if the route is cooling down, `false` otherwise.
   */
  isCoolingDown(routeKey: string): boolean;

  /**
   * Retrieves the current cooldown state for a route.
   *
   * @param routeKey - The model-level route identifier.
   * @returns The `CooldownState` object if the route is cooling down, otherwise `undefined`.
   */
  getCooldownState(routeKey: string): CooldownState | undefined;

  /**
   * Clears the cooldown state for a specific route.
   * @param routeKey - The model-level route identifier.
   */
  clearCooldown(routeKey: string): void;

  /**
   * Retrieves all active cooldown states.
   * @returns A map of all active cooldown states by route key.
   */
  getAllCooldownStates(): Map<string, CooldownState>;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

interface PersistedEntry {
  until: string; // ISO string
  reason: string;
}

function loadFromDisk(
  persistPath: string,
  log: ReturnType<typeof logger.child>,
): Map<string, CooldownState> {
  try {
    const raw = fs.readFileSync(persistPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, PersistedEntry>;
    const now = new Date();
    const loaded = new Map<string, CooldownState>();
    for (const [routeKey, entry] of Object.entries(parsed)) {
      const until = new Date(entry.until);
      if (until > now) {
        loaded.set(routeKey, { until, reason: entry.reason });
      }
    }
    log.info({ count: loaded.size, persistPath }, "loaded cooldown state from disk");
    return loaded;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ err: (err as Error).message, persistPath }, "failed to read cooldown state file");
    }
    return new Map();
  }
}

function persistToDisk(
  persistPath: string,
  cooldowns: Map<string, CooldownState>,
  log: ReturnType<typeof logger.child>,
): void {
  try {
    const out: Record<string, PersistedEntry> = {};
    for (const [routeKey, state] of cooldowns.entries()) {
      out[routeKey] = { until: state.until.toISOString(), reason: state.reason };
    }
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, JSON.stringify(out, null, 2), "utf8");
  } catch (err) {
    log.warn({ err: (err as Error).message, persistPath }, "failed to persist cooldown state to disk");
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Creates a `ProviderCooldownService` instance.
 *
 * When `options.persistPath` is provided, cooldown state is written to disk on
 * every mutation and reloaded on startup — quota-exhausted routes survive restarts.
 *
 * Keys should be model-route identifiers such as "gemini_local:gemini-2.5-flash"
 * so different models from the same provider cool down independently.
 */
export function createProviderCooldownService(
  options: ProviderCooldownOptions = {},
): ProviderCooldownService {
  const { persistPath } = options;
  const log = logger.child({ service: "provider-cooldown" }) as ReturnType<typeof logger.child>;

  /** In-memory store for route cooldown states, optionally pre-loaded from disk. */
  const cooldowns: Map<string, CooldownState> = persistPath
    ? loadFromDisk(persistPath, log)
    : new Map();

  function persist(): void {
    if (persistPath) {
      persistToDisk(persistPath, cooldowns, log);
    }
  }

  function setCooldown(
    routeKey: string,
    durationMs: number,
    reason: string,
  ): void {
    const now = new Date();
    const newUntil = new Date(now.getTime() + durationMs);

    const existingCooldown = cooldowns.get(routeKey);
    if (existingCooldown && existingCooldown.until > newUntil) {
      log.debug(
        { routeKey, existingUntil: existingCooldown.until.toISOString(), newUntil: newUntil.toISOString() },
        "existing cooldown is longer, not extending",
      );
      return;
    }

    cooldowns.set(routeKey, { until: newUntil, reason });
    log.info(
      { routeKey, durationMs, reason, until: newUntil.toISOString() },
      "route put on cooldown",
    );
    persist();
  }

  function isCoolingDown(routeKey: string): boolean {
    const cooldown = cooldowns.get(routeKey);
    if (!cooldown) return false;

    const now = new Date();
    if (now < cooldown.until) {
      return true;
    } else {
      cooldowns.delete(routeKey);
      log.debug({ routeKey }, "cooldown expired and removed");
      persist();
      return false;
    }
  }

  function getCooldownState(routeKey: string): CooldownState | undefined {
    // Calling isCoolingDown will also clean up expired cooldowns
    if (isCoolingDown(routeKey)) {
      return cooldowns.get(routeKey);
    }
    return undefined;
  }

  function clearCooldown(routeKey: string): void {
    if (cooldowns.has(routeKey)) {
      cooldowns.delete(routeKey);
      log.info({ routeKey }, "cooldown cleared");
      persist();
    }
  }

  function getAllCooldownStates(): Map<string, CooldownState> {
    // Filter out expired cooldowns before returning
    const activeCooldowns = new Map<string, CooldownState>();
    const now = new Date();
    let pruned = false;
    for (const [routeKey, state] of cooldowns.entries()) {
      if (now < state.until) {
        activeCooldowns.set(routeKey, state);
      } else {
        cooldowns.delete(routeKey);
        pruned = true;
      }
    }
    if (pruned) persist();
    return activeCooldowns;
  }

  return {
    setCooldown,
    isCoolingDown,
    getCooldownState,
    clearCooldown,
    getAllCooldownStates,
  };
}
