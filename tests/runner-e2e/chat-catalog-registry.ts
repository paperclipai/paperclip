import { validNativeStopDeclaration, assertNativeStopCallback } from "./chat-native-stop-boundary.js";
import { validSlackIngressDeclaration } from "./chat-slack-ingress.js";
import { validCompanionDeclaration } from "./chat-companion-surface.js";
import { assertExpectedWorkerCancellation } from "./chat-catalog-run-policy.js";
import { installedChatScenarioIds } from "./chat-installed-lane.js";
import { existsSync, readFileSync } from "node:fs";
import { validChatCatalogHumanCounts } from "./chat-catalog-contract.js";
import type { ChatCatalogCase } from "./chat-catalog-contract.js";
import { chatCatalogScenarios } from "./chat-catalog-inventory.js";
import type { IdentityBoundaryCase } from "./chat-catalog-domains/identity-boundary-contract.js";
import { identityBoundaryScenarioIds } from "./chat-catalog-domains/identity-boundary-contract.js";

export type ChatCatalogDescriptor = Omit<ChatCatalogCase, "expectedCancelledWorkerRun" | "beforeCanonicalSend" | "dispatchSlackOtherThread" | "verifySlackSupportedTransfer" | "dispatchSlackUnsupportedFile" | "dispatchSlackQuery" | "runCompanionSurface" | "journeyKind" | "setup" | "act" | "observe" | "grade" | "cleanup" | "verifyResult" | "verifySetup" | "verifyQueryRejection"> & {
  journeyKind?: "agent-chat" | "browser-boundary" | "scoped-external-assistant" | "native-slack-thread";
  boundaryTarget?: "authenticated-harness" | "empty-installed-target";
  modulePath: string;
  exportName: string;
};
/** Pure discovery metadata. Importing the catalog never evaluates a domain module. */
export const chatCatalogCases: readonly ChatCatalogDescriptor[] = JSON.parse(
  readFileSync(new URL("./chat-catalog-descriptors.json", import.meta.url), "utf8"),
);
const known = new Set(chatCatalogScenarios.map(row => row.id));
export function findChatCatalogCase(scenarioId: string): ChatCatalogDescriptor | undefined {
  const matches = chatCatalogCases.filter(row => row.scenarioId === scenarioId);
  if (matches.length > 1) throw new Error(`Duplicate chat implementation: ${scenarioId}`);
  const descriptor = matches[0];
  if (!descriptor) return;
  if (descriptor.runPolicy?.kind === "source-settled-with-active-work" && descriptor.runPolicy.expectedWorkerCancellation !== undefined
    && (scenarioId !== "tasks.edit-properties" || descriptor.runPolicy.expectedWorkerCancellation !== "owned-task-reassignment"))
    throw new Error("Worker reassignment cancellation is declared only for edit-properties");
  if ((descriptor.companionSurface || descriptor.journeyKind === "scoped-external-assistant") && !validCompanionDeclaration(descriptor)) throw new Error("Only the declared scoped-client catalog case may select an external assistant");
  if ((descriptor.slackIngress || descriptor.journeyKind === "native-slack-thread") && !validSlackIngressDeclaration(descriptor)) throw new Error("Only two declared Slack thread cases may use native ingress");
  if (descriptor.canonicalBoundary && !validNativeStopDeclaration(descriptor)) throw new Error("Native Stop boundary is exclusive to the exact human post-stop scenario");
  if (descriptor.browserTimezone && (scenarioId !== "routines.create-daily-brief" || descriptor.browserTimezone !== "America/Chicago"))
    throw new Error("Browser timezone is declared only for the canonical Chicago weekday routine");
  if (descriptor.respondingAgent && (scenarioId !== "cases.handoff-same-task" || Object.keys(descriptor.respondingAgent).length !== 4
    || descriptor.respondingAgent.kind !== "case-primary-owner" || descriptor.respondingAgent.name !== "Morgan" || descriptor.respondingAgent.role !== "engineer" || descriptor.respondingAgent.canAssignTasks !== true))
    throw new Error("A non-CEO responding fixture is declared only for the canonical Morgan primary-owner handoff");
  if (descriptor.installedSource && (descriptor.installedSource !== "published-global-npm" || !(installedChatScenarioIds as readonly string[]).includes(scenarioId)))
    throw new Error("Installed ordinary Chat is allowlisted only for the two published-source operator scenarios");
  if (!known.has(scenarioId) || !descriptor.oracleVersion || !descriptor.sourceFiles.length
    || !/^\.\/chat-catalog-domains\/[a-z0-9-]+\.js$/.test(descriptor.modulePath)
    || !descriptor.exportName || (!["browser-boundary", "scoped-external-assistant"].includes(descriptor.journeyKind ?? "agent-chat") && !validChatCatalogHumanCounts(descriptor)) || descriptor.expectedRunCount < 0 || descriptor.turnTimeoutMs <= 0 || descriptor.attemptTimeoutMs <= 0
    || (descriptor.minimumRunCount ?? descriptor.expectedRunCount) > descriptor.expectedRunCount)
    throw new Error(`Incomplete bounds/provenance for ${scenarioId}`);
  return descriptor;
}
/** Source-local Playwright imports need the real .ts URL; compiled consumers retain .js. */
export function chatCatalogModuleUrl(modulePath: string): string {
  const source = new URL(modulePath.replace(/\.js$/, ".ts"), import.meta.url);
  return existsSync(source) ? source.href : new URL(modulePath, import.meta.url).href;
}
export async function loadChatCatalogImplementation(
  descriptor: ChatCatalogDescriptor,
  importer: (specifier: string) => Promise<Record<string, unknown>> = specifier => import(specifier),
): Promise<ChatCatalogCase> {
  if (descriptor.journeyKind === "browser-boundary") throw new Error("Browser boundary cannot enter ordinary Agent Chat dispatch");
  // The sole dynamic import boundary: only the selected descriptor's module executes.
  const module = await importer(chatCatalogModuleUrl(descriptor.modulePath));
  const implementations = module[descriptor.exportName];
  if (!Array.isArray(implementations)) throw new Error(`Missing domain export: ${descriptor.exportName}`);
  const selected = implementations.filter((row: ChatCatalogCase) => row.scenarioId === descriptor.scenarioId);
  if (selected.length !== 1) throw new Error(`Missing or duplicate runtime case: ${descriptor.scenarioId}`);
  const implementation = selected[0] as ChatCatalogCase;
  assertExpectedWorkerCancellation(implementation);
  if (implementation.optionalCompanySecretBindingApproval === true
    ? !validChatCatalogHumanCounts(implementation) || implementation.scenarioId!=="secrets.configure-company-secret" || implementation.expectedRunCount!==3 || implementation.minimumRunCount!==2 || typeof implementation.expectedCompanySecretBindingApproval!=="function"
    : implementation.expectedCompanySecretBindingApproval!==undefined) throw new Error("Invalid optional governed company approval declaration");
  for (const key of ["sourceFiles", "oracleVersion", "expectedRunCount", "minimumRunCount", "expectedHumanMessageCount", "optionalCompanySecretBindingApproval", "setupHumanMessageCount", "turnTimeoutMs", "attemptTimeoutMs", "coverageGaps", "journeyKind", "authentication", "setupPolicy", "runPolicy", "queryOutcome", "queryBindings", "queryAttachments", "requiredCredentials", "externalInput", "installedSource", "browserTimezone", "respondingAgent", "companionSurface", "slackIngress", "canonicalBoundary"] as const) {
    if (JSON.stringify(implementation[key]) !== JSON.stringify(descriptor[key])) throw new Error(`Runtime descriptor drift: ${descriptor.scenarioId}.${key}`);
  }
  if ((descriptor.companionSurface || descriptor.journeyKind === "scoped-external-assistant") && (!validCompanionDeclaration(implementation) || typeof implementation.runCompanionSurface !== "function" || implementation.act)) throw new Error("Missing actual finite scoped assistant driver");
  if ((descriptor.slackIngress || descriptor.journeyKind === "native-slack-thread") && (!validSlackIngressDeclaration(implementation) || typeof implementation.dispatchSlackQuery !== "function" || implementation.act)) throw new Error("Missing finite actual Slack ingress driver");
  if (descriptor.scenarioId === "chat-channels.channel-file" && descriptor.slackIngress && (typeof implementation.verifySlackSupportedTransfer !== "function" || typeof implementation.dispatchSlackUnsupportedFile !== "function")) throw new Error("Slack file case requires actual supported and unsupported transfer phases");
  if ((descriptor.scenarioId !== "chat-channels.channel-file" || !descriptor.slackIngress) && (implementation.verifySlackSupportedTransfer || implementation.dispatchSlackUnsupportedFile)) throw new Error("Undeclared Slack file conditional");
  const declaredOtherThread = descriptor.scenarioId === "chat-channels.reply-in-thread" && descriptor.slackIngress?.setupThread === "same-agent-distractor";
  if (declaredOtherThread ? typeof implementation.dispatchSlackOtherThread !== "function" : implementation.dispatchSlackOtherThread !== undefined) throw new Error("Missing or undeclared Slack other-thread callback");
  assertNativeStopCallback(implementation);
  if (!descriptor.slackIngress && implementation.dispatchSlackQuery) throw new Error("Undeclared Slack ingress driver");
  if (!descriptor.companionSurface && implementation.runCompanionSurface) throw new Error("Undeclared external assistant driver");
  if ((descriptor.setupPolicy?.funding === "preserve-scenario" || descriptor.setupPolicy?.readiness === "preserve-scenario")
    && (!descriptor.setupPolicy.invariantCheckIds.length || typeof implementation.verifySetup !== "function"))
    throw new Error("Scenario-specific setup policy requires independent prerequisite assertions");
  if (descriptor.queryOutcome === "rejected" && typeof implementation.verifyQueryRejection !== "function")
    throw new Error("Rejected chat query requires independent rejection evidence");
  if ([implementation.setup, implementation.observe, implementation.grade, implementation.verifyResult].some(value => typeof value !== "function"))
    throw new Error(`Incomplete executable case: ${descriptor.scenarioId}`);
  return implementation;
}

/** Separate typed dispatch: no company, agent, or ChatFlowInput is fabricated. */
export async function loadIdentityBoundaryImplementation(descriptor: ChatCatalogDescriptor,
  importer: (specifier: string) => Promise<Record<string, unknown>> = specifier => import(specifier)): Promise<IdentityBoundaryCase> {
  if (descriptor.canonicalBoundary || descriptor.journeyKind !== "browser-boundary" || !(identityBoundaryScenarioIds as readonly string[]).includes(descriptor.scenarioId))
    throw new Error("Only explicit catalog browser boundaries may bypass Agent Chat prerequisites");
  if (descriptor.scenarioId === "agent-chat.chat-disabled" && (descriptor.boundaryTarget !== "authenticated-harness" || descriptor.authentication !== "human-session"))
    throw new Error("Disabled Agent Chat requires the actual owned authenticated company target");
  if (descriptor.expectedRunCount !== 0 || (descriptor.minimumRunCount ?? 0) !== 0 || descriptor.expectedHumanMessageCount !== 0 || (descriptor.setupHumanMessageCount ?? 0) !== 0)
    throw new Error("Pre-chat boundaries require zero agent admissions and zero persisted chat queries");
  const module = await importer(chatCatalogModuleUrl(descriptor.modulePath));
  const rows = module[descriptor.exportName];
  const selected = Array.isArray(rows) ? rows.filter(row => row.scenarioId === descriptor.scenarioId) : [];
  if (selected.length !== 1) throw new Error("Missing or duplicate browser boundary implementation");
  const implementation = selected[0] as IdentityBoundaryCase;
  for (const key of ["sourceFiles", "oracleVersion", "expectedRunCount", "minimumRunCount", "expectedHumanMessageCount", "optionalCompanySecretBindingApproval", "setupHumanMessageCount", "turnTimeoutMs", "attemptTimeoutMs", "coverageGaps", "journeyKind", "boundaryTarget", "authentication", "setupPolicy", "runPolicy", "queryOutcome", "queryBindings", "queryAttachments", "requiredCredentials", "externalInput", "installedSource"] as const) {
    if (JSON.stringify(implementation[key]) !== JSON.stringify(descriptor[key])) throw new Error(`Runtime boundary descriptor drift: ${descriptor.scenarioId}.${key}`);
  }
  if ([implementation.run, implementation.grade, implementation.cleanup].some(value => typeof value !== "function") || descriptor.queryBindings?.length || descriptor.queryAttachments?.length
    || !["authenticated-harness", "empty-installed-target"].includes(String(descriptor.boundaryTarget)))
    throw new Error("Boundary requires executable outcome, independent grade and cleanup; query bindings are Agent Chat only");
  return implementation;
}
