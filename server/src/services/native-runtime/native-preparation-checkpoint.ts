import { createHash } from "node:crypto";
import type { DurablePrpCheckpoint, DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import type { NativeRunnerCheckpointOwner } from "./native-runner-checkpoint.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { isDeepStrictEqual } from "node:util";

export type NativePreparationPublication = {
  schema: "paperclip.native-preparation-publication.v1";
  kind: "preparing" | "launching";
  identity: DurableRecoveryIdentity;
  bootId: string;
  generation: number;
  leaseOwner: string;
  headerSha256: string;
  cursorSha256: string;
  partsSha256: string;
  configurationId: string | null;
};

export const preparationSha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function rebindNativeLaunchMaterials(materials: Record<string, unknown>, scope: {
  companyId: string; issueId: string; runId: string;
}, previous: NativePreparationPublication, next: NativePreparationPublication) {
  const patch: Record<string, unknown> = {}, cipher = createLocalEncryptedCipher("write");
  if (!isDeepStrictEqual(previous.identity, next.identity)) throw new Error("native_runner_launch_authority_unproven");
  for (const key of ["nativeRunnerLaunchIntent", "nativeRemoteRunnerLaunchIntent"]) {
    const material = materials[key];
    if (material == null) continue;
    const value = JSON.parse(createLocalEncryptedCipher("read").decrypt(material as Record<string, unknown>));
    if (value.companyId !== scope.companyId || value.issueId !== scope.issueId || value.runId !== scope.runId
      || value.bootId !== previous.bootId || value.generation !== previous.generation || value.leaseOwner !== previous.leaseOwner) {
      throw new Error("native_runner_launch_authority_unproven");
    }
    if (key === "nativeRunnerLaunchIntent") {
      const runner = value.operation?.runner, identity = previous.identity;
      if (value.schema !== "paperclip.native-runner-launch-intent.v1" || value.operation?.kind !== "submit"
        || value.operation.preparedLaunchId !== previous.configurationId || !runner
        || runner.runnerId !== identity.runnerInstanceId || runner.leaseId !== identity.environmentLeaseId
        || runner.runId !== identity.runId || runner.sessionId !== identity.normalizedSessionId
        || runner.turnId !== identity.turnId || runner.itemId !== identity.itemId) throw new Error("native_runner_launch_authority_unproven");
    } else {
      const publication = value.publication ?? value.intent?.checkpoint;
      if (value.schema !== "paperclip.native-remote-runner-launch.v1" || !isDeepStrictEqual(value.intent?.identity, previous.identity)
        || publication?.headerSha256 !== previous.headerSha256 || publication?.cursorSha256 !== previous.cursorSha256
        || publication?.partsSha256 !== previous.partsSha256) throw new Error("native_runner_launch_authority_unproven");
    }
    patch[key] = cipher.encrypt(JSON.stringify({ ...value, bootId: next.bootId, generation: next.generation, leaseOwner: next.leaseOwner,
      publication: { headerSha256: next.headerSha256, cursorSha256: next.cursorSha256, partsSha256: next.partsSha256 } }));
  }
  return patch;
}

export function nativePreparationPublication(checkpoint: DurablePrpCheckpoint,
  owner: NativeRunnerCheckpointOwner): NativePreparationPublication | null {
  if (owner.runId !== owner.authorityRunId || checkpoint.predecessor || checkpoint.records.size > 20) return null;
  const headerText = checkpoint.records.get("header"), cursorText = checkpoint.records.get("cursor");
  if (!headerText || !cursorText || Buffer.byteLength(headerText) > 1024 * 1024) return null;
  const header = JSON.parse(headerText), state = header.state, cursor = JSON.parse(cursorText);
  if (header.schema !== "paperclip.runner.controller-checkpoint.v3" || !state || state.preparationHandoff?.version !== 1
    || state.identity?.runId !== owner.runId
    || state.checkpointEventPolicy !== "control-v1" || state.warmTransition || state.completedWarmTransition
    || state.stagedRunAttachment || ![0, 2].includes(cursor.commandCount) || cursor.eventCount > 16
    || checkpoint.records.size !== 2 + cursor.commandCount + cursor.eventCount) return null;
  const commands = [...checkpoint.records].filter(([key]) => key.startsWith("command:"))
    .map(([, value]) => JSON.parse(value)).sort((a, b) => a.controllerSeq - b.controllerSeq);
  if (commands.length !== cursor.commandCount || commands.some((command, index) =>
    command.type !== ["run.prepare", "session.open"][index])) return null;
  const issued = state.bootstrapHistory?.credentialsIssued;
  if (!Number.isSafeInteger(issued) || issued < 0 || state.bootstrapHistory?.adopted !== false) return null;
  const configurations = (state.preparedLaunchConfigurations ?? []).filter((entry: { identity: DurableRecoveryIdentity }) =>
    JSON.stringify(entry.identity) === JSON.stringify(state.identity));
  if (!Array.isArray(configurations) || configurations.length > 1) return null;
  const configurationId = configurations[0]?.configurationId ?? null;
  if (configurationId !== null && (typeof configurationId !== "string" || !configurationId)) return null;
  if (cursor.commandCount === 0 && (issued !== 0 || cursor.eventCount !== 0 || state.connectionCount !== 0)) return null;
  return { schema: "paperclip.native-preparation-publication.v1",
    kind: issued === 0 ? "preparing" : "launching", identity: state.identity,
    bootId: owner.bootId, generation: owner.generation, leaseOwner: owner.leaseOwner,
    headerSha256: preparationSha256(headerText), cursorSha256: preparationSha256(cursorText),
    partsSha256: preparationSha256(JSON.stringify([...checkpoint.records.keys()].sort())), configurationId };
}
