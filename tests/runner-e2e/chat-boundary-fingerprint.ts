import { chatPrivateInputRequirements, chatPrivateInputNameIdentity } from "./chat-private-inputs.js";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fingerprintChatDependencyClosure } from "./chat-catalog-fingerprint.js";
import type { ChatCatalogDescriptor } from "./chat-catalog-registry.js";
import type { MatrixExecution } from "./types.js";

/** The campaign ledger is mutable; only this selected frozen scenario is
 * definition metadata. Executable sources and unknown closure stay byte-bound.
 */
export function boundaryScenarioMetadata(manifest: unknown, scenarioId: string) {
  const rows = (manifest as { scenarios?: unknown } | null)?.scenarios;
  if (!scenarioId.trim() || !Array.isArray(rows)) throw new Error(`Missing frozen boundary scenario: ${scenarioId}`);
  const matches = rows.filter(row => row && typeof row === "object" && row.id === scenarioId);
  if (matches.length !== 1) throw new Error(`Missing or duplicate frozen boundary scenario: ${scenarioId}`);
  const { id, capabilities, context, query, expected_outcome } = matches[0];
  if (!Array.isArray(capabilities) || !capabilities.every(value => typeof value === "string")
    || [context, query, expected_outcome].some(value => typeof value !== "string" || !value.trim()))
    throw new Error(`Invalid frozen boundary scenario: ${scenarioId}`);
  return { id, capabilities, context, query, expected_outcome };
}

/** Independent boundary lane: never relax assertChatCatalogFingerprintLane. */
export function chatBoundaryFingerprint(descriptor: ChatCatalogDescriptor, execution: MatrixExecution, env: NodeJS.ProcessEnv = process.env, retainedPrivateInputNames?: ReturnType<typeof chatPrivateInputNameIdentity>) {
  if (descriptor.journeyKind !== "browser-boundary" || execution.environment.id !== "local" || execution.suite.id !== "chat-features")
    throw new Error("Boundary fingerprint requires an explicitly selected local browser boundary");
  const privateInputNameIdentity = retainedPrivateInputNames === undefined ? chatPrivateInputNameIdentity(execution.id, env) : retainedPrivateInputNames;
  let installedIdentity: unknown = null;
  if (descriptor.boundaryTarget === "empty-installed-target") {
    const cli = env.PAPERCLIP_CHAT_BOUNDARY_CLI; const expectedCli = env.PAPERCLIP_CHAT_BOUNDARY_CLI_SHA256;
    const expectedServer = env.PAPERCLIP_CHAT_BOUNDARY_SERVER_SHA256;
    if (!cli || !path.isAbsolute(cli) || !expectedCli || !expectedServer) throw new Error("Empty-installation boundary requires actual immutable installed CLI and server identity pins");
    if (realpathSync(cli) !== cli) throw new Error("Boundary installed CLI must be canonical and unlinked");
    const cliManifest = JSON.parse(readFileSync(path.resolve(path.dirname(cli), "../package.json"), "utf8"));
    const serverManifestPath = findPackageJSON("@paperclipai/server", pathToFileURL(cli));
    if (!serverManifestPath) throw new Error("Boundary CLI has no resolvable installed server");
    const serverManifest = JSON.parse(readFileSync(serverManifestPath, "utf8"));
    const serverEntry = path.join(path.dirname(serverManifestPath), "dist/index.js");
    const digest = (name: string) => createHash("sha256").update(readFileSync(name)).digest("hex");
    const cliSha256 = digest(cli); const serverSha256 = digest(serverEntry);
    if (cliManifest.name !== "paperclipai" || serverManifest.name !== "@paperclipai/server" || cliManifest.version !== serverManifest.version
      || cliSha256 !== expectedCli || serverSha256 !== expectedServer) throw new Error("Boundary installed CLI/server differ from their declared pins");
    installedIdentity = { version: cliManifest.version, cliSha256, serverSha256 };
  } else if (descriptor.boundaryTarget !== "authenticated-harness") throw new Error("Boundary target identity is undeclared");
  const scenario = boundaryScenarioMetadata(JSON.parse(readFileSync(new URL("./chat-campaign-manifest.json", import.meta.url), "utf8")), descriptor.scenarioId);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = fingerprintChatDependencyClosure({ root,
    entries: [`tests/runner-e2e/${descriptor.modulePath.slice(2)}`, "tests/runner-e2e/chat-boundary-flow.ts", "tests/runner-e2e/chat-boundary-fingerprint.ts",
      "tests/runner-e2e/runner.spec.ts", "tests/runner-e2e/launch.ts", ...descriptor.sourceFiles.map(file => `tests/runner-e2e/${file}`)],
    selected: { descriptor, scenario, journeyKind: "browser-boundary", executionId: execution.id, privateInputRequirements: chatPrivateInputRequirements(descriptor), privateInputNameIdentity, requiredCredentialNames: execution.requiredCredentials, environment: execution.environment.id, installedIdentity },
    selectedDispatchFile: "tests/runner-e2e/chat-catalog-registry.ts",
    normalizedMetadata: { "tests/runner-e2e/chat-catalog-descriptors.json": descriptor,
      "tests/runner-e2e/chat-campaign-manifest.json": scenario },
  });
  return { ...result, privateInputNameIdentity, privateInputRequirements: chatPrivateInputRequirements(descriptor) };
}
