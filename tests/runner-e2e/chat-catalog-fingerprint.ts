import { reviewedChatProfile } from "./chat-runtime-profile.js";
import { publicOriginFingerprintIdentity } from "./chat-public-origin.js";
import { databaseFingerprintIdentity } from "./docker-postgres.js";
import { verifyRetainedChatOracleIdentity } from "./chat-private-inputs.js";
import { installedChatFingerprintIdentity, installedChatScenarioIds } from "./chat-installed-lane.js";
import { chatPrivateInputRequirements, chatPrivateInputNameIdentity } from "./chat-private-inputs.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import type { MatrixExecution } from "./types.js";
import type { ChatCatalogDescriptor } from "./chat-catalog-registry.js";

// Spawned by path rather than imported, so name them explicitly; the Python
// sandbox wraps every agent process and decides its filesystem isolation.
export const chatCatalogSpawnedSourceEntries = ["tests/runner-e2e/server.ts", "tests/runner-e2e/server-entry.ts", "tests/runner-e2e/agent-filesystem-sandbox.py"] as const;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function resolveSource(specifier: string, parent: string): string {
  const absolute = path.resolve(path.dirname(parent), specifier);
  const candidates = [absolute.replace(/\.js$/, ".ts"), absolute.replace(/\.js$/, ".tsx"), absolute,
    `${absolute}.ts`, `${absolute}.tsx`, path.join(absolute, "index.ts"), path.join(absolute, "index.tsx")];
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Unresolved fingerprint dependency: ${specifier} from ${parent}`);
  return found;
}
function conservativeSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "target", "results", "test-results", "playwright-report"].includes(entry.name)) return [];
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? conservativeSources(child) : /\.(ts|tsx|js|mjs|json|yaml)$/.test(entry.name) ? [child] : [];
  });
}
/** Compile and inspect actual executable imports, rather than trusting a hand-maintained sourceFiles list. */
export function fingerprintChatDependencyClosure(input: {
  root: string; entries: readonly string[]; selected: unknown;
  /** Only pure metadata may be normalized; executable modules may never use this escape. */
  normalizedMetadata?: Readonly<Record<string, unknown>>;
  /** The registry's one variable import is bound to selected.modulePath above. */
  selectedDispatchFile?: string;
  reviewedDynamicResolutions?: Readonly<Record<string, { sourceSha256: string; resolution: string; dependencies: readonly string[] }>>;

}) {
  const files = new Map<string, string>();
  const unknownDynamicImports: string[] = [];
  const resolvedDynamicImports: Array<{ file: string; resolution: string }> = [];
  const visit = (absolute: string) => {
    const relative = path.relative(input.root, absolute).split(path.sep).join("/");
    if (relative.startsWith("../")) throw new Error(`Fingerprint dependency escaped repository: ${relative}`);
    if (files.has(relative)) return;
    const normalized = input.normalizedMetadata?.[relative];
    if (normalized !== undefined) { files.set(relative, JSON.stringify(normalized)); return; }
    const body = readFileSync(absolute, "utf8");
    files.set(relative, body);
    if (!/\.[cm]?[jt]sx?$/.test(absolute)) return;
    const parsed = buildSync({ stdin: { contents: body, sourcefile: absolute,
      loader: absolute.endsWith(".tsx") ? "tsx" : /\.ts$/.test(absolute) ? "ts" : "js" },
      bundle: false, metafile: true, write: false, format: "esm", platform: "node", minifyWhitespace: true,
      legalComments: "none", logLevel: "silent" });
    const dependencies = Object.values(parsed.metafile!.outputs).flatMap(output => output.imports.map(item => item.path));
    if (/\bimport\s*\(\s*(?!["'])/.test(parsed.outputFiles[0]!.text) && relative !== input.selectedDispatchFile) {
      const reviewed = input.reviewedDynamicResolutions?.[relative];
      if (reviewed && reviewed.sourceSha256 === hash(body)) {
        resolvedDynamicImports.push({ file: relative, resolution: reviewed.resolution });
        for (const dependency of reviewed.dependencies) visit(path.resolve(input.root, dependency));
      } else unknownDynamicImports.push(relative);
    }
    for (const dependency of dependencies.filter(value => value.startsWith("."))) visit(resolveSource(dependency, absolute));
  };
  for (const entry of input.entries) visit(resolveSource(`./${entry}`, path.join(input.root, "entry.ts")));
  // Unknown imports conservatively bind all source files.
  if (unknownDynamicImports.length) for (const absolute of conservativeSources(input.root)) {
    const relative = path.relative(input.root, absolute).split(path.sep).join("/");
    if (!files.has(relative)) files.set(relative, input.normalizedMetadata?.[relative] !== undefined
      ? JSON.stringify(input.normalizedMetadata[relative]) : readFileSync(absolute, "utf8"));
  }
  for (const name of ["package.json", "pnpm-lock.yaml"]) if (existsSync(path.join(input.root, name))) files.set(name, readFileSync(path.join(input.root, name), "utf8"));
  const sources = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, body]) => ({ file, sha256: hash(body) }));
  const digest = hash(JSON.stringify({ selected: input.selected, sources }));
  return { digest, definitionDigest: digest, graderDigest: digest, fingerprintKind: "complete-execution-and-oracle-closure",
    sources, resolvedDynamicImports, unknownDynamicImports: [...new Set(unknownDynamicImports)].sort() };
}

export function assertChatCatalogFingerprintLane(selected: unknown, env: NodeJS.ProcessEnv = process.env, args: readonly string[] = process.argv) {
  const execution = selected as { suiteId?: string; flow?: string; environment?: string; executionId?: string; scenarioId?: string; installedSource?: string; databaseLane?: unknown; profile?: { id?: string; provider?: string; model?: string; adapterType?: string; credential?: string } };
  const database = databaseFingerprintIdentity(env);
  if (execution.databaseLane !== undefined && JSON.stringify(execution.databaseLane) !== JSON.stringify(database)) throw new Error("Selected database lane differs from fingerprint environment");
  const installed = execution.installedSource === "published-global-npm" && (installedChatScenarioIds as readonly string[]).includes(String(execution.scenarioId));
  const installedKeys = ["PAPERCLIP_RUNNER_E2E_INSTALLED_CLI", "PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256",
    "PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT", "PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256", "PAPERCLIP_RUNNER_E2E_INSTALLED_STARTUP_ONLY"];
  const forbiddenArguments = ["--target-config", "--github-review-config", "--connection-config", "--installed-startup-only", "product-journeys"];
  if (installed && !reviewedChatProfile(execution.profile) || execution.suiteId !== "chat-features" || execution.flow !== "agent_chat" || execution.environment !== "local"
    || !installed && installedKeys.some(key => env[key] && env[key] !== "0") || args.some(argument => forbiddenArguments.includes(argument)))
    throw new Error("Reviewed dynamic resolutions require source-local Agent Chat without external dispatch overrides");
  return { suiteId: execution.suiteId, flow: execution.flow, environment: execution.environment,
    database, installedLane: installed, externalJourneyDispatch: false };
}

export function chatCatalogCaseFingerprint(descriptor: ChatCatalogDescriptor, selectedExecution: unknown, retainedPrivateInputNames?: ReturnType<typeof chatPrivateInputNameIdentity>, retainedInstalledIdentity?: Omit<ReturnType<typeof installedChatFingerprintIdentity>, "observedProcess">) {
  selectedExecution = { ...(selectedExecution as Record<string, unknown>), journeyKind: descriptor.journeyKind ?? "agent-chat" };
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const privateInputNameIdentity = retainedPrivateInputNames === undefined ? chatPrivateInputNameIdentity((selectedExecution as { executionId: string }).executionId) : retainedPrivateInputNames;
  if (retainedPrivateInputNames !== undefined) verifyRetainedChatOracleIdentity(retainedPrivateInputNames, descriptor);
  const lane = assertChatCatalogFingerprintLane({ ...(selectedExecution as Record<string, unknown>), scenarioId: descriptor.scenarioId, installedSource: descriptor.installedSource });
  const installedObservation = descriptor.installedSource && retainedInstalledIdentity === undefined
    ? installedChatFingerprintIdentity(process.env, (selectedExecution as { executionId: string }).executionId) : undefined;
  const installedIdentity = descriptor.installedSource ? retainedInstalledIdentity ?? (installedObservation && {
    kind: installedObservation.kind, sourceVersion: installedObservation.sourceVersion, cliSha256: installedObservation.cliSha256,
    serverSha256: installedObservation.serverSha256, treeSha256: installedObservation.treeSha256, publishedArtifacts: installedObservation.publishedArtifacts,
  }) : null;
  const reviewedDynamicResolutions = JSON.parse(readFileSync(new URL("./chat-catalog-dynamic-resolutions.json", import.meta.url), "utf8"));
  const selectedModule = `tests/runner-e2e/${descriptor.modulePath.slice(2)}`;
  const scenario = JSON.parse(readFileSync(new URL("./chat-campaign-manifest.json", import.meta.url), "utf8")).scenarios
    .find((row: { id: string }) => row.id === descriptor.scenarioId);
  if (!scenario) throw new Error(`Missing frozen scenario: ${descriptor.scenarioId}`);
  const { id, capabilities, context, query, expected_outcome } = scenario;
  const attachmentFormatter = descriptor.queryAttachments?.length ? ["ui/src/components/IssueChatThread.tsx", "ui/src/components/task-chat/TaskChatComposer.tsx"].map(file => ({
    file, sha256: hash(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")),
  })) : null;
  const originIdentity = publicOriginFingerprintIdentity((selectedExecution as { executionId: string }).executionId, descriptor.scenarioId);
  const originReaders = originIdentity.selected ? ["server/src/config.ts", "server/src/auth/better-auth.ts", "server/src/routes/tool-access.ts", "server/src/services/chat-task-url.ts", "server/src/services/muse-setup.ts", "server/src/services/workspace-runtime.ts", "tests/runner-e2e/chat-catalog-domains/external-public-signin-worker.ts", "tests/runner-e2e/chat-catalog-domains/external-public-signin-contract.ts", "ui/src/pages/Auth.tsx"] : [];
  const result = fingerprintChatDependencyClosure({ root,
    entries: [selectedModule, ...chatCatalogSpawnedSourceEntries, "tests/runner-e2e/chat-catalog-flow.ts", "tests/runner-e2e/chat-catalog-fingerprint.ts", "tests/runner-e2e/chat-catalog-dynamic-resolutions.json",
      "tests/runner-e2e/chat-feature-flow.ts", "tests/runner-e2e/runner.spec.ts", "tests/runner-e2e/launch.ts",
      "tests/runner-e2e/chat-scenarios/defaults.yaml", ...originReaders, ...descriptor.sourceFiles.map(file => `tests/runner-e2e/${file}`)],
    selected: { descriptor, selectedExecution, lane, publicOriginIdentity: originIdentity, attachmentFormatter, privateInputRequirements: chatPrivateInputRequirements(descriptor), privateInputNameIdentity, installedIdentity, scenario: { id, capabilities, context, query, expected_outcome } },
    reviewedDynamicResolutions,
    selectedDispatchFile: "tests/runner-e2e/chat-catalog-registry.ts",
    normalizedMetadata: { "tests/runner-e2e/chat-catalog-descriptors.json": descriptor,
      "tests/runner-e2e/chat-campaign-manifest.json": { id, capabilities, context, query, expected_outcome } },
  });
  return { ...result, databaseLaneIdentity: lane.database, attachmentFormatter, privateInputNameIdentity, installedIdentity, installedSourceProcess: installedObservation?.observedProcess, privateInputRequirements: chatPrivateInputRequirements(descriptor) };
}

export function normalizedChatCatalogExecution(execution: MatrixExecution) {
  return { executionId: execution.id, suiteId: execution.suite.id, flow: execution.task.flow, journeyKind: "agent-chat",
    profile: { id: execution.profile.id, provider: execution.profile.provider, model: execution.profile.model, adapterType: execution.profile.adapterType, credential: execution.profile.credential },
    environment: execution.environment.id, databaseLane: databaseFingerprintIdentity(), requiredCredentialNames: execution.requiredCredentials, task: { expectedRunCount: execution.task.expectedRunCount,
      minimumExpectedRunCount: execution.task.minimumExpectedRunCount, turnTimeoutMs: execution.task.turnTimeoutMs,
      ...(execution.task.optionalCompanySecretBindingApproval===true?{expectedHumanMessageCount:execution.task.expectedHumanMessageCount,optionalCompanySecretBindingApproval:true}:{}),
      attemptTimeoutMs: execution.task.attemptTimeoutMs } };
}
export function legacyChatFeatureFingerprint(execution: MatrixExecution) {
  if (!["create-backlog", "delegate-announcement"].includes(execution.task.id)) throw new Error("Unknown legacy chat feature case");
  return chatCatalogCaseFingerprint({ scenarioId: `tasks.${execution.task.id}`, modulePath: "./chat-feature-flow.js", exportName: "runChatFeatureFlow",
    sourceFiles: ["chat-feature-flow.ts", "chat-feature-scoring.ts", "chat-scenarios/tasks.yaml", "completion-updates.ts"],
    oracleVersion: "paperclip.chat-features.v1", expectedRunCount: execution.task.expectedRunCount,
    expectedHumanMessageCount: 1, turnTimeoutMs: execution.task.turnTimeoutMs!, attemptTimeoutMs: execution.task.attemptTimeoutMs.local,
  }, normalizedChatCatalogExecution(execution));
}
