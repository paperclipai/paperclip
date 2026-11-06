import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  rm,
  copyFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, dirname, relative } from "node:path";
import * as t from "../../packages/db/src/index.js";
import { eq } from "drizzle-orm";
import { startRecoveryPostgres } from "../src/__tests__/helpers/recovery-postgres.js";
import { prepareRemoteOpenCodeArtifacts } from "../src/services/native-runtime/remote-opencode-artifacts.js";
import {
  retainNativeProviderArtifacts,
  retainExistingNativeProviderArtifacts,
} from "../src/services/native-runtime/native-provider-artifacts.js";
import { createStorageService } from "../src/storage/service.js";
import { createLocalDiskStorageProvider } from "../src/storage/local-disk-provider.js";
import {
  reserveRemoteWorkspace,
  prepareRemoteWorkspace,
  saveRemoteWorkspace,
  clearRemoteWorkspaceLocationForReleasedLease,
} from "../src/services/remote-workspaces.js";
import { remoteTerminationReceipt } from "../src/services/remote-execution-termination.js";
import {
  nativeHarnessBackupOwner,
  persistNativeHarnessBackup,
  restoreDurableNativeHarnessBackup,
} from "../src/services/native-runtime/native-harness-backup-storage.js";
import {
  buildNativeHarnessBackupManifest,
  resolveNativeHarnessPersistenceProfile,
  providerSessionIdentityFromDurableProviderState,
} from "../src/services/native-runtime/native-session-executor.js";
import {
  nativeRunnerCheckpointWriter,
  restoreNativeRunnerCheckpoint,
} from "../src/services/native-runtime/native-runner-checkpoint.js";
import {
  nativeProviderPackAdmissionPending,
  rememberAdmittedNativeProviderPack,
  recordNativeProviderPackAdmission,
  rememberRecoveredNativeProviderPack,
} from "../src/services/native-runtime/native-provider-pack-admission.js";
import { captureLegacyDurablePrpCheckpoint } from "../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.js";

const exec = promisify(execFile),
  repo = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    "old-image": { type: "string" },
    "new-image": { type: "string" },
    context: { type: "string", default: "desktop-linux" },
    output: { type: "string" },
  },
});
if (!values["old-image"] || !values["new-image"] || !values.output)
  throw Error(
    "Required: --old-image sha256:<64 hex> --new-image sha256:<64 hex> --output <absolute JSON path>",
  );
if (process.env.PAPERCLIP_TEST_DATABASE_URL)
  throw Error(
    "Qualification requires its own local embedded PostgreSQL server",
  );
const images = { old: values["old-image"], next: values["new-image"] };
for (const image of Object.values(images))
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw Error("Only exact cached image IDs are supported");
if (!values.output.startsWith("/")) throw Error("Output must be absolute");
const context = values.context ?? "desktop-linux";
const docker = async (args: string[]) => {
  const result = await exec("docker", ["--context", context, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
  return result.stdout.trim();
};
const contextMetadata = JSON.parse(
  await docker(["context", "inspect", context]),
);
if (!contextMetadata[0]?.Endpoints?.docker?.Host?.startsWith("unix://"))
  throw Error("Qualification requires a local Unix Docker endpoint");
const metadata = {} as Record<
  string,
  { Id: string; Architecture: string; Os: string }
>;
for (const [name, image] of Object.entries(images)) {
  const [details] = JSON.parse(await docker(["image", "inspect", image]));
  if (
    details.Id !== image ||
    details.Os !== "linux" ||
    !["amd64", "arm64"].includes(details.Architecture)
  )
    throw Error("Cached Linux image identity mismatch");
  metadata[name] = {
    Id: details.Id,
    Architecture: details.Architecture,
    Os: details.Os,
  };
}
if (metadata.old.Architecture !== metadata.next.Architecture)
  throw Error("Images must have matching architectures");
const root = await mkdtemp(join(tmpdir(), "paperclip-native-cold-full-"));
process.env.PAPERCLIP_HOME = join(root, "fixture-home");
process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
const home = "/home/native-fixture",
  base = home + "/paperclip-workspace",
  account = userInfo();
const passwd = join(root, "passwd");
await writeFile(
  passwd,
  account.uid === 0
    ? `root:x:0:0:Owned fixture:${home}:/bin/sh\n`
    : `root:x:0:0:root:/root:/bin/sh\nnative-fixture:x:${account.uid}:${account.gid}:Owned fixture:${home}:/bin/sh\n`,
);
const extract = async (image: string, source: string, destination: string) => {
  const id = await docker([
    "create",
    "--pull=never",
    "--entrypoint",
    "node",
    image,
    "--version",
  ]);
  try {
    await docker(["cp", `${id}:${source}`, destination]);
  } finally {
    await docker(["rm", id]);
  }
};
await extract(
  images.old,
  "/opt/paperclip-runner/provider-pack/provider-pack.json",
  join(root, "old-provider-pack.json"),
);
await extract(
  images.next,
  "/opt/paperclip-runner/provider-pack/provider-pack.json",
  join(root, "new-provider-pack.json"),
);
await extract(
  images.next,
  "/app/server/dist/vendor/paperclip-runner/bin/paperclip-runnerd",
  join(root, "paperclip-runnerd"),
);
const manifest = JSON.parse(
  await readFile(join(root, "old-provider-pack.json"), "utf8"),
);
const nextManifest = JSON.parse(
  await readFile(join(root, "new-provider-pack.json"), "utf8"),
);
if (
  manifest.payload.artifacts.opencodeProxy.sha256 ===
  nextManifest.payload.artifacts.opencodeProxy.sha256
)
  throw Error(
    "Qualification requires an actual upgraded proxy with different bytes",
  );
const source = {
  revision: (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repo })
  ).stdout.trim(),
  dirty: Boolean(
    (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
  ),
  node: process.version,
};
const containers = new Map<string, string>();
const create = async (first: boolean) => {
  const path = join(root, first ? "original-account" : "replacement-account");
  await mkdir(join(path, "paperclip-workspace"), { recursive: true });
  await chmod(path, 0o700);
  const id = await docker([
    "create",
    "--pull=never",
    "--platform",
    "linux/" + metadata.old.Architecture,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${account.uid}:${account.gid}`,
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,size=536870912,mode=1777",
    "--mount",
    `type=bind,src=${repo},dst=${repo},readonly`,
    "--mount",
    `type=bind,src=${path},dst=${home}`,
    "--mount",
    `type=bind,src=${passwd},dst=/etc/passwd,readonly`,
    "--mount",
    `type=bind,src=${join(root, "paperclip-runnerd")},dst=/qualified-runnerd,readonly`,
    "--mount",
    `type=bind,src=${fileURLToPath(new URL("./fixtures/opencode-cold-recovery.mjs", import.meta.url))},dst=/native-probe.mjs,readonly`,
    "--env",
    `HOME=${home}`,
    "--entrypoint",
    "node",
    first ? images.old : images.next,
    "-e",
    "setTimeout(()=>{},600000)",
  ]);
  containers.set(id, path);
  await docker(["start", id]);
  return { id, path };
};
const mapped = (path: string, file: string) => {
  if (!file.startsWith(home + "/")) throw Error("unowned remote path");
  return join(path, relative(home, file));
};
const runner = (id: string, path: string) => {
  const transfer = (out: boolean) => async (ops: any[]) => {
    const results = [];
    for (const o of ops) {
      for (const f of o.files) {
        const src = out ? mapped(path, f.sourcePath) : f.sourcePath,
          dst = out ? f.targetPath : mapped(path, f.targetPath);
        await mkdir(dirname(dst), { recursive: true });
        await cp(src, dst, { recursive: f.kind === "directory" });
        if (f.mode) await chmod(dst, f.mode);
      }
      results.push({
        operationId: o.operationId,
        filesTransferred: o.files.length,
        bytesTransferred: 0,
      });
    }
    return { operations: results };
  };
  return {
    execute: async (input: any) => {
      try {
        const args = [
          "--context",
          context,
          "exec",
          "--workdir",
          input.cwd ?? base,
        ];
        for (const [k, v] of Object.entries(input.env ?? {}))
          args.push("--env", `${k}=${v}`);
        const r = await exec(
          "docker",
          [...args, id, input.command, ...(input.args ?? [])],
          { maxBuffer: 8 * 1024 * 1024, timeout: input.timeoutMs ?? 180000 },
        );
        return {
          exitCode: 0,
          stdout: r.stdout,
          stderr: r.stderr,
          signal: null,
          timedOut: false,
        };
      } catch (e: any) {
        return {
          exitCode: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          signal: null,
          timedOut: false,
        };
      }
    },
    syncIn: transfer(false),
    syncOut: transfer(true),
  };
};
const stage = (path: string) => async (f: any) => {
  await copyFile(f.sourcePath, mapped(path, f.targetPath), 1);
  await chmod(mapped(path, f.targetPath), f.mode);
};
const ids = {
  company: randomUUID(),
  agent: randomUUID(),
  issue: randomUUID(),
  run: randomUUID(),
  environment: randomUUID(),
  lease: randomUUID(),
  boot: randomUUID(),
};
const identity = {
  runnerInstanceId: randomUUID(),
  environmentLeaseId: ids.lease,
  runId: ids.run,
  normalizedSessionId: randomUUID(),
  turnId: randomUUID(),
  itemId: randomUUID(),
};
const binding = {
    companyId: ids.company,
    agentId: ids.agent,
    issueId: ids.issue,
    runId: ids.run,
  },
  scopeDigest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
const database = await startRecoveryPostgres("opencode-native-cold-");
process.env.DATABASE_URL = database.connectionString;
const db = t.createDb(database.connectionString);
const disk = createStorageService(
    createLocalDiskStorageProvider(join(root, "objects")),
  ),
  uploads: any[] = [];
const storage = {
  ...disk,
  provider: "s3" as const,
  putFile: async (input: any) => {
    uploads.push({ namespace: input.namespace, byteSize: input.byteSize });
    return disk.putFile(input);
  },
};
const claim = {
  leaseOwner: "cold-owner",
  attempt: 1,
  controllerGeneration: 1,
  controllerBootId: ids.boot,
};
const facade = {
  identity: () => ({ ...binding, sessionId: identity.normalizedSessionId }),
} as any;
let execution: any, workspace: string, runtime: string;
const probe = async (id: string, input: any) => {
  const out = await docker([
    "exec",
    id,
    "node",
    "/native-probe.mjs",
    JSON.stringify({
      sdk: repo + "/packages/paperclip-runner/dist",
      manifest,
      workspace,
      runtime,
      identity,
      home,
      ...input,
    }),
  ]);
  const line = out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (!line) throw Error("missing probe receipt");
  await writeFile(join(root, `phase-${input.phase}.json`), line);
  return JSON.parse(line);
};
try {
  await db.insert(t.companies).values({
    id: ids.company,
    name: "Owned cold recovery qualification",
    issuePrefix: "COLD",
  });
  await db.insert(t.agents).values({
    id: ids.agent,
    companyId: ids.company,
    name: "Owned native worker",
    adapterType: "paperclip_runner",
  });
  await db.insert(t.environments).values({
    id: ids.environment,
    name: ids.environment,
    driver: "sandbox",
    config: {},
  });
  await db.insert(t.issues).values({
    id: ids.issue,
    companyId: ids.company,
    title: "Preserve useful cold work",
    status: "in_progress",
    assigneeAgentId: ids.agent,
  });
  const epoch = randomUUID();
  await db.insert(t.heartbeatRuns).values({
    id: ids.run,
    companyId: ids.company,
    agentId: ids.agent,
    nativeIssueId: ids.issue,
    runtimeMode: "native",
    status: "running",
    driverKind: "opencode_server",
    nativeSessionId: identity.normalizedSessionId,
    runnerInstanceId: identity.runnerInstanceId,
    runnerProfileJson: {
      nativeProviderPackAdmissionState:
        nativeProviderPackAdmissionPending(epoch),
    },
  });
  await db
    .update(t.issues)
    .set({ executionRunId: ids.run })
    .where(eq(t.issues.id, ids.issue));
  await db.insert(t.nativeRunFinalizations).values({
    runId: ids.run,
    companyId: ids.company,
    issueId: ids.issue,
    phase: "observed",
    attempt: 1,
    controllerGeneration: 1,
    controllerBootId: ids.boot,
    leaseOwner: claim.leaseOwner,
    leaseExpiresAt: new Date(Date.now() + 900000),
  });
  await db.insert(t.environmentLeases).values({
    id: ids.lease,
    companyId: ids.company,
    environmentId: ids.environment,
    heartbeatRunId: ids.run,
    issueId: ids.issue,
    provider: "daytona",
    providerLeaseId: "allocation-" + ids.lease,
    status: "active",
  });
  const lease = async (id: string) =>
    (
      await db
        .select()
        .from(t.environmentLeases)
        .where(eq(t.environmentLeases.id, id))
    )[0] as any;
  const original = await create(true),
    oldRunner = runner(original.id, original.path);
  const target = (a: any, id: string) =>
    ({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: base,
      runner: runner(a.id, a.path),
      provider: "daytona",
      leaseId: id,
      sandboxId: "allocation-" + id,
      timeoutMs: 180000,
    }) as any;
  const oldTarget = target(original, ids.lease);
  const reserve = (existingWorkspaceId: string | null) =>
    reserveRemoteWorkspace({
      db,
      storage,
      ...binding,
      environmentId: ids.environment,
      projectId: null,
      projectWorkspaceId: null,
      existingWorkspaceId,
      source: { kind: "empty" },
    });
  const reserved = await reserve(null),
    prepared = await prepareRemoteWorkspace({
      db,
      storage,
      workspace: reserved,
      runId: ids.run,
      lease: await lease(ids.lease),
      target: oldTarget,
    });
  workspace = prepared.remoteRoot;
  runtime =
    workspace +
    "/.paperclip-runtime/paperclip-runner/sessions/retained/filesystem/opencode";
  execution = {
    binding: { ...binding, executionWorkspaceId: reserved.id },
    provider: { kind: "opencode", model: "paperclip/qualification" },
    workspace: {
      cwd: workspace,
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId: identity.normalizedSessionId,
      driverKind: "opencode_server",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 },
    },
  };
  const launch = await prepareRemoteOpenCodeArtifacts({
    runner: oldRunner as never,
    bootstrapNode: "/usr/local/bin/node",
    manifest,
    nonce: randomUUID(),
    sourceRoot: "/opt/paperclip-runner/provider-pack",
    stageFile: stage(original.path),
  });
  const originalState = home + "/controller-original",
    initialized = await probe(original.id, {
      phase: "init",
      state: originalState,
      artifactRoot: launch.root,
    });
  if (
    !rememberAdmittedNativeProviderPack(facade, {
      identity: facade.identity(),
      runnerInstanceId: identity.runnerInstanceId,
      environmentLeaseId: identity.environmentLeaseId,
      manifest,
    })
  )
    throw Error("admission unavailable");
  if (
    !(await recordNativeProviderPackAdmission(db, {
      session: facade,
      identity: facade.identity(),
      admissionEpoch: epoch,
      claim,
    }))
  )
    throw Error("admission not recorded");
  const owner = await nativeHarnessBackupOwner(db, {
    ...binding,
    bootId: ids.boot,
  });
  const receipt = await retainNativeProviderArtifacts({
    db,
    storage,
    owner,
    source: {
      sourceRoot: mapped(original.path, launch.root),
      manifest,
      launchRoot: launch.root,
      accountUid: launch.accountUid,
    },
    signal: AbortSignal.timeout(180000),
  });
  const first = await probe(original.id, {
    phase: "first",
    state: originalState,
    artifactRoot: launch.root,
    thread: initialized.thread,
  });
  if (first.lifecycle !== "suspended")
    throw Error("source runner not suspended");
  await writeFile(
    mapped(original.path, workspace + "/useful-result.txt"),
    "retained useful workspace result",
  );
  const saved = await saveRemoteWorkspace({
    db,
    storage,
    workspace: prepared.workspace,
    runId: ids.run,
    lease: prepared.lease,
    target: oldTarget,
    assertOwned: async () => {},
  });
  const checkpoint = captureLegacyDurablePrpCheckpoint(
    await readFile(
      mapped(
        original.path,
        originalState + "/control-plane/control-plane-state.json",
      ),
      "utf8",
    ),
    {
      runId: ids.run,
      runnerInstanceId: identity.runnerInstanceId,
      normalizedSessionId: identity.normalizedSessionId,
    },
  );
  await nativeRunnerCheckpointWriter(db, {
    ...owner,
    leaseOwner: claim.leaseOwner,
  })(checkpoint);
  const nativeRoot = join(root, "old-controller-backup");
  await mkdir(nativeRoot);
  for (const d of resolveNativeHarnessPersistenceProfile(execution)
    .directories) {
    const src = mapped(
      original.path,
      d.name === "runner" ? originalState + "/runner" : runtime,
    );
    await cp(src, join(nativeRoot, d.name), {
      recursive: true,
      filter: (path) =>
        !(d.excludeEntries ?? []).some(
          (e) =>
            relative(src, path) === e ||
            relative(src, path).startsWith(e + "/"),
        ),
    });
  }
  const providerState = JSON.parse(
    await readFile(
      join(nativeRoot, "runner/codex-provider-state.json"),
      "utf8",
    ),
  );
  const nativeManifest = buildNativeHarnessBackupManifest({
    backupRoot: nativeRoot,
    execution,
    runnerInstanceId: identity.runnerInstanceId,
    providerSessionIdentity: providerSessionIdentityFromDurableProviderState({
      execution,
      providerState,
    }),
    sourceProviderLeaseId: prepared.lease.providerLeaseId,
  });
  nativeManifest.providerArtifacts = receipt;
  await writeFile(
    join(nativeRoot, "manifest.json"),
    JSON.stringify(nativeManifest),
  );
  await persistNativeHarnessBackup({
    db,
    storage,
    owner,
    scopeDigest,
    root: nativeRoot,
    signal: AbortSignal.timeout(180000),
  });
  const [recorded] = await db
    .select()
    .from(t.heartbeatRuns)
    .where(eq(t.heartbeatRuns.id, ids.run));
  await docker(["stop", "--time", "5", original.id]);
  await docker(["rm", original.id]);
  containers.delete(original.id);
  const stopped = {
    ...prepared.lease,
    status: "released",
    releasedAt: new Date(),
    cleanupStatus: "success",
    metadata: {
      ...prepared.lease.metadata,
      remoteExecutionTermination: remoteTerminationReceipt(prepared.lease, {
        providerLeaseId: prepared.lease.providerLeaseId,
        state: "destroyed",
      }),
    },
  } as any;
  await db
    .update(t.environmentLeases)
    .set({
      status: stopped.status,
      releasedAt: stopped.releasedAt,
      cleanupStatus: "success",
      metadata: stopped.metadata,
    })
    .where(eq(t.environmentLeases.id, ids.lease));
  await db.transaction((tx) =>
    clearRemoteWorkspaceLocationForReleasedLease({ db: tx, lease: stopped }),
  );
  await rm(original.path, { recursive: true, force: true });
  await rm(nativeRoot, { recursive: true, force: true });
  const replacement = await create(false),
    nextLease = randomUUID();
  await db.insert(t.environmentLeases).values({
    id: nextLease,
    companyId: ids.company,
    environmentId: ids.environment,
    heartbeatRunId: ids.run,
    issueId: ids.issue,
    provider: "daytona",
    providerLeaseId: "allocation-" + nextLease,
    status: "active",
  });
  const restoredWorkspace = await prepareRemoteWorkspace({
    db,
    storage,
    workspace: await reserve(reserved.id),
    runId: ids.run,
    lease: await lease(nextLease),
    target: target(replacement, nextLease),
  });
  if (restoredWorkspace.remoteRoot !== workspace)
    throw Error("published cwd changed");
  if (
    (await readFile(
      mapped(replacement.path, workspace + "/useful-result.txt"),
      "utf8",
    )) !== "retained useful workspace result"
  )
    throw Error("workspace file lost");
  const restored = join(root, "new-controller");
  await mkdir(restored, { mode: 0o700 });
  await restoreNativeRunnerCheckpoint(
    db,
    binding,
    restored,
    identity.normalizedSessionId,
  );
  if (
    !(await restoreDurableNativeHarnessBackup({
      db,
      storage,
      companyId: ids.company,
      scopeDigest,
      backupRoot: join(restored, "failover-backups"),
      signal: AbortSignal.timeout(180000),
    }))
  )
    throw Error("durable harness unavailable");
  const current = join(restored, "failover-backups/current"),
    nextState = home + "/controller-replacement";
  await mkdir(mapped(replacement.path, nextState), {
    recursive: true,
    mode: 0o700,
  });
  await cp(
    join(restored, "control-plane"),
    mapped(replacement.path, nextState + "/control-plane"),
    { recursive: true },
  );
  await cp(
    join(current, "runner"),
    mapped(replacement.path, nextState + "/runner"),
    { recursive: true },
  );
  await mkdir(dirname(mapped(replacement.path, runtime)), { recursive: true });
  await cp(join(current, "opencode"), mapped(replacement.path, runtime), {
    recursive: true,
  });
  const recovered = await prepareRemoteOpenCodeArtifacts({
    runner: runner(replacement.id, replacement.path) as never,
    bootstrapNode: "/usr/local/bin/node",
    manifest,
    nonce: randomUUID(),
    restored: { receipt, directory: join(current, "provider-artifacts") },
    stageFile: stage(replacement.path),
  });
  const nextEpoch = randomUUID(),
    nextBoot = randomUUID();
  await db
    .update(t.nativeRunFinalizations)
    .set({
      controllerBootId: nextBoot,
      controllerGeneration: 2,
      leaseOwner: "cold-successor",
      leaseExpiresAt: new Date(Date.now() + 900000),
    })
    .where(eq(t.nativeRunFinalizations.runId, ids.run));
  await db
    .update(t.heartbeatRuns)
    .set({
      runnerProfileJson: {
        ...recorded.runnerProfileJson,
        nativeProviderPackAdmissionState:
          nativeProviderPackAdmissionPending(nextEpoch),
      },
    })
    .where(eq(t.heartbeatRuns.id, ids.run));
  if (
    !(await rememberRecoveredNativeProviderPack(db, facade, {
      identity: facade.identity(),
      sourceRunId: ids.run,
      runnerInstanceId: identity.runnerInstanceId,
      environmentLeaseId: identity.environmentLeaseId,
      source: {
        runId: ids.run,
        receipt: recorded.runnerProfileJson?.nativeProviderPackAdmission,
        state: recorded.runnerProfileJson?.nativeProviderPackAdmissionState,
      },
    }))
  )
    throw Error("recovered admission unavailable");
  if (
    !(await recordNativeProviderPackAdmission(db, {
      session: facade,
      identity: facade.identity(),
      admissionEpoch: nextEpoch,
      claim: {
        ...claim,
        leaseOwner: "cold-successor",
        controllerGeneration: 2,
        controllerBootId: nextBoot,
      },
    }))
  )
    throw Error("recovered admission not recorded");
  await retainExistingNativeProviderArtifacts({
    db,
    owner: await nativeHarnessBackupOwner(db, { ...binding, bootId: nextBoot }),
    receipt,
  });
  const resumed = await probe(replacement.id, {
    phase: "resume",
    state: nextState,
    artifactRoot: recovered.root,
    thread: first.thread,
  });
  const result = {
    root,
    status: "passed",
    images,
    metadata,
    source,
    oldPack: manifest.digest,
    newPack: nextManifest.digest,
    first,
    resumed,
    sameLaunchPaths:
      JSON.stringify(launch.paths) === JSON.stringify(recovered.paths),
    canonicalCwd: workspace,
    oldLease: ids.lease,
    newLease: nextLease,
    workspaceSnapshot: saved.snapshotId,
    uploads,
    controllerCheckpoint: "encrypted real PostgreSQL reload",
    harness: "AES authenticated object reload",
    network: "none; local synthetic model only",
  };
  await writeFile(values.output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const [id] of containers) {
    await docker(["stop", "--time", "5", id]).catch(() => {});
    await docker(["rm", id]).catch(() => {});
  }
  await t.closeRegisteredClients(database.connectionString, {
    scope: "database",
  });
  await database.cleanup();
  console.error("Owned qualification files retained at " + root);
}
