import { createRequire } from "node:module";
import type { BlogPipelineStepInput, BlogPipelineStepResult } from "./types.js";

const require = createRequire(import.meta.url);

const LEGACY_RESEARCH_PATH = "/Users/daehan/.openclaw/workspace/mac-pipeline/lib/research/run-research-step.js";
const LEGACY_DRAFT_PATH = "/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-step.js";
const LEGACY_DRAFT_REVIEW_PATH = "/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-review-step.js";
const LEGACY_DRAFT_POLISH_PATH = "/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-polish-step.js";
const LEGACY_FINAL_REVIEW_PATH = "/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-final-review-step.js";
const LEGACY_VALIDATE_PATH = "/Users/daehan/.openclaw/workspace/mac-pipeline/lib/validate/run-validate-step.js";
const LEGACY_IMAGE_PATH = "/Users/daehan/.openclaw/workspace/mac-pipeline/lib/image/run-image-step.js";
const LEGACY_PUBLIC_VERIFY_PATH = "/Users/daehan/.openclaw/workspace/mac-pipeline/lib/verify/run-public-verify-step.js";

type LegacyStepRunner = (input: BlogPipelineStepInput) => Promise<BlogPipelineStepResult>;

function getLegacyStepRunner(modulePath: string, exportName: string): LegacyStepRunner {
  const mod = require(modulePath) as Record<string, unknown>;
  const runner = mod[exportName];
  if (typeof runner !== "function") {
    throw new Error(`legacy_step_runner_missing:${exportName}`);
  }
  return runner as LegacyStepRunner;
}

export async function runResearchStep(input: BlogPipelineStepInput): Promise<BlogPipelineStepResult> {
  return getLegacyStepRunner(LEGACY_RESEARCH_PATH, "runResearchStep")(input);
}

export async function runDraftStep(input: BlogPipelineStepInput): Promise<BlogPipelineStepResult> {
  return getLegacyStepRunner(LEGACY_DRAFT_PATH, "runDraftStep")(input);
}

export async function runDraftReviewStep(input: BlogPipelineStepInput): Promise<BlogPipelineStepResult> {
  return getLegacyStepRunner(LEGACY_DRAFT_REVIEW_PATH, "runDraftReviewStep")(input);
}

export async function runDraftPolishStep(input: BlogPipelineStepInput): Promise<BlogPipelineStepResult> {
  return getLegacyStepRunner(LEGACY_DRAFT_POLISH_PATH, "runDraftPolishStep")(input);
}

export async function runFinalReviewStep(input: BlogPipelineStepInput): Promise<BlogPipelineStepResult> {
  return getLegacyStepRunner(LEGACY_FINAL_REVIEW_PATH, "runFinalReviewStep")(input);
}

export async function runValidateStep(input: BlogPipelineStepInput): Promise<BlogPipelineStepResult> {
  return getLegacyStepRunner(LEGACY_VALIDATE_PATH, "runValidateStep")(input);
}

export async function runImageStep(input: BlogPipelineStepInput): Promise<BlogPipelineStepResult> {
  return getLegacyStepRunner(LEGACY_IMAGE_PATH, "runImageStep")(input);
}

export async function runPublicVerifyStep(input: BlogPipelineStepInput): Promise<BlogPipelineStepResult> {
  return getLegacyStepRunner(LEGACY_PUBLIC_VERIFY_PATH, "runPublicVerifyStep")(input);
}

export type {
  BlogPipelineRunContext,
  BlogPipelineStepInput,
  BlogPipelineStepResult,
} from "./types.js";
