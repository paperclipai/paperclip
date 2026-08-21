/**
 * Decides whether an issue may transition to `done`.
 *
 * An agent's completion report is not evidence. The gate only trusts a work product that was
 * declared with a concrete location and independently verified to exist there. The expectation
 * is pinned by whoever *created* the issue, not by whoever executes it — so an agent cannot
 * redefine the target to match whatever it happened to produce.
 */

import {
  ISSUE_COMPLETION_REQUIREMENTS,
  WORK_PRODUCT_TYPES,
  type IssueCompletionRequirement,
  type WorkProductType,
} from "@paperclipai/shared";

export const COMPLETION_REQUIREMENT_KINDS = ISSUE_COMPLETION_REQUIREMENTS;
export type CompletionRequirement = IssueCompletionRequirement;
export { WORK_PRODUCT_TYPES };
export type { WorkProductType };

export type WorkProductHealth = "verified" | "missing" | "unknown";

export interface ExpectedWorkProduct {
  type: WorkProductType;
  /** Path, commit SHA, document id or URL. `null` pins only the type. */
  location: string | null;
}

export interface DeclaredWorkProduct {
  type: string;
  provider: string;
  externalId: string | null;
  url: string | null;
  isPrimary: boolean;
  healthStatus: string;
}

export type CompletionGateReason =
  | "no_work_product"
  | "unverified_work_product"
  | "expectation_mismatch";

export interface CompletionGateDecision {
  allowed: boolean;
  reason?: CompletionGateReason;
  message?: string;
}

function normalizeLocation(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The location an agent claims for a product: a path/SHA/id, or a URL for link-shaped products. */
function declaredLocation(product: DeclaredWorkProduct): string | null {
  return normalizeLocation(product.externalId) ?? normalizeLocation(product.url);
}

export function matchesExpectation(
  expected: ExpectedWorkProduct,
  product: DeclaredWorkProduct,
): boolean {
  if (product.type !== expected.type) return false;
  const wanted = normalizeLocation(expected.location);
  if (!wanted) return true;
  const actual = declaredLocation(product);
  if (!actual) return false;
  return actual.toLowerCase() === wanted.toLowerCase();
}

function describeExpectation(expected: ExpectedWorkProduct): string {
  return expected.location ? `${expected.type} at \`${expected.location}\`` : `a ${expected.type}`;
}

function describeProduct(product: DeclaredWorkProduct): string {
  const location = declaredLocation(product);
  return location ? `${product.type} at \`${location}\`` : product.type;
}

export function decideCompletionGate(input: {
  requirement: CompletionRequirement;
  expected: ExpectedWorkProduct | null;
  declared: DeclaredWorkProduct[];
}): CompletionGateDecision {
  if (input.requirement === "none") return { allowed: true };

  const primary = input.declared.filter((product) => product.isPrimary);
  if (primary.length === 0) {
    const target = input.expected ? describeExpectation(input.expected) : "the required artifact";
    return {
      allowed: false,
      reason: "no_work_product",
      message: `Cannot mark this issue done: no work product was declared. Declare ${target} and let Paperclip verify it. A completion comment is not evidence.`,
    };
  }

  const candidates = input.expected
    ? primary.filter((product) => matchesExpectation(input.expected!, product))
    : primary;

  if (candidates.length === 0) {
    const found = primary.map(describeProduct).join(", ");
    return {
      allowed: false,
      reason: "expectation_mismatch",
      message: `Cannot mark this issue done: it expected ${describeExpectation(input.expected!)}, but the declared work product is ${found}. An artifact delivered to the wrong location is not done.`,
    };
  }

  const verified = candidates.filter((product) => product.healthStatus === "verified");
  if (verified.length === 0) {
    const unverified = candidates
      .map((product) => `${describeProduct(product)} (${product.healthStatus})`)
      .join(", ");
    return {
      allowed: false,
      reason: "unverified_work_product",
      message: `Cannot mark this issue done: the declared work product could not be verified — ${unverified}. Paperclip checked the location and did not find it.`,
    };
  }

  return { allowed: true };
}
