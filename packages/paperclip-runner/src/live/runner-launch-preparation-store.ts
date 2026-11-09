import { resolve } from "node:path";
import type { DurableRecoveryIdentity } from "../contracts/durable-recovery.js";
import { atomicPrivateWrite, readPrivateFile, durableRecoveryInternals } from "../control-plane/durable-prp-control-plane.js";
import { runnerLaunchRequirementsDigest, validatePreparedRunnerLaunch,
  type PreparedRunnerProviderLaunch, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";

interface LaunchPreparation {
  requirements: RunnerProviderLaunchRequirements;
  prepared: PreparedRunnerProviderLaunch;
}

const schema = "paperclip.runner.launch-preparation-store.v1";
const sameIdentity = (left: DurableRecoveryIdentity, right: DurableRecoveryIdentity) =>
  Object.keys(right).every(key => left[key as keyof DurableRecoveryIdentity] === right[key as keyof DurableRecoveryIdentity]);

/** Keep the current and previous run through an interrupted authority handoff. */
export class RunnerLaunchPreparationStore {
  readonly #path: string;
  constructor(directory: string) { this.#path = resolve(directory, "launch-preparation.json"); }

  #read(): LaunchPreparation[] {
    const contents = readPrivateFile(this.#path);
    if (contents === null) return [];
    const value = JSON.parse(contents);
    if (value?.schema !== schema || !Array.isArray(value.entries) || value.entries.length > 2) {
      throw new Error("runner_launch_recovery_requirements_unavailable");
    }
    for (const entry of value.entries) {
      if (entry?.requirements?.schema !== "paperclip.runner.launch-requirements.v1"
        || !entry.requirements.identity) throw new Error("runner_launch_recovery_requirements_unavailable");
      validatePreparedRunnerLaunch(entry.requirements, entry.prepared);
    }
    return value.entries;
  }

  load(identity: DurableRecoveryIdentity): LaunchPreparation | undefined {
    return this.#read().find(entry => sameIdentity(entry.requirements.identity, identity));
  }

  save(requirements: RunnerProviderLaunchRequirements, prepared: PreparedRunnerProviderLaunch, activeIdentity: DurableRecoveryIdentity): void {
    validatePreparedRunnerLaunch(requirements, prepared);
    const entries = this.#read();
    const existing = entries.find(entry => sameIdentity(entry.requirements.identity, requirements.identity));
    if (existing && (runnerLaunchRequirementsDigest(existing.requirements) !== runnerLaunchRequirementsDigest(requirements)
      || existing.prepared.configurationId !== prepared.configurationId
      || durableRecoveryInternals.canonicalJson(existing.prepared) !== durableRecoveryInternals.canonicalJson(prepared))) {
      throw new Error("runner_prepared_launch_recovery_changed");
    }
    const active = entries.find(entry => sameIdentity(entry.requirements.identity, activeIdentity));
    atomicPrivateWrite(this.#path, JSON.stringify({ schema,
      entries: existing ? entries : [{ requirements, prepared }, ...(active ? [active] : [])],
    }));
  }
}
