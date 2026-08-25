/**
 * Development shim for the package-local runner runtime.
 *
 * Source-mode server entry points do not build workspace dependencies first,
 * so this shim loads the package source through the TypeScript runtime. The
 * server build replaces the emitted shim with the package's compiled `dist`
 * tree so published server packages have no workspace runtime dependency.
 * Keep server imports pointed at this relative boundary.
 */
type RunnerModule = typeof import("@paperclipai/paperclip-runner");

export type {
  PaperclipJsonValue,
  PaperclipQuestionResponse,
  PaperclipSemanticActionBinding,
  PaperclipSemanticActionId,
  PaperclipSemanticAuthorizationRecord,
  PaperclipSemanticRunContext,
  PaperclipSemanticToolCall,
  PaperclipSemanticToolDefinition,
  PaperclipSemanticToolResult,
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
  PaperclipRuntimeInputRequest,
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "@paperclipai/paperclip-runner";
export type DurablePrpControlPlane =
  import("@paperclipai/paperclip-runner").DurablePrpControlPlane;
export type PaperclipSemanticDispatcher =
  import("@paperclipai/paperclip-runner").PaperclipSemanticDispatcher;

const sourceUrl = new URL(
  "../../../../packages/paperclip-runner/src/index.ts",
  import.meta.url,
);
const runner = await import(sourceUrl.href) as RunnerModule;

export const DurablePrpControlPlane = runner.DurablePrpControlPlane;
export const PaperclipSemanticDispatcher = runner.PaperclipSemanticDispatcher;
export const parsePaperclipQuestionSet = runner.parsePaperclipQuestionSet;
export const parsePaperclipQuestionResponse = runner.parsePaperclipQuestionResponse;
export const validatePrpEvent = runner.validatePrpEvent;
export const validatePrpStructuredRunResult =
  runner.validatePrpStructuredRunResult;
