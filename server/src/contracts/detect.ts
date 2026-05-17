import type { ContractType, IssueForContracts, CommentForContracts } from "./types.js";

const CODE_CHANGE_LABEL_NAMES = new Set([
  "type/feature",
  "type/bug",
  "type/fix",
  "type/refactor",
  "type/test",
  "type/docs",
  "type/infra",
]);

const META_TITLE_PREFIXES = ["[EPIC]", "[META]", "Meta:"];
const META_LABEL_NAMES = new Set(["kind/epic", "kind/tracker", "type/epic", "type/tracker"]);
const DESIGN_LABEL_NAMES = new Set(["kind/design", "type/design"]);

/**
 * Pure detection function — no I/O, deterministic.
 * Returns the set of all matching contract types.
 * `meta-no-artifact` is mutually exclusive with all others when matched.
 */
export function detectContractTypes(
  issue: IssueForContracts,
  comments: CommentForContracts[],
): ContractType[] {
  const labelNames = issue.labels.map((l) => l.name);

  // 1. telegram-origin
  const isTelegramOrigin =
    issue.originKind === "telegram" ||
    issue.originKind === "interactive" &&
      comments.some((c) => /^\[telegram:inbound\]/m.test(c.body)) ||
    comments.some((c) => /^\[telegram:inbound\]/m.test(c.body));

  // 2. bridge-dispatched
  const isBridgeDispatched =
    issue.originKind === "bridge_dispatch" ||
    (issue.description ?? "").includes("[engineering:dispatch]");

  // 3. code-change
  const hasCodeLabel = labelNames.some((n) => CODE_CHANGE_LABEL_NAMES.has(n));
  const descriptionReferencesWork =
    /acceptance criteria/i.test(issue.description ?? "") &&
    /(#\d+|github\.com\/[^/]+\/[^/]+\/pull\/\d+|\/compare\/|branch\/)/i.test(issue.description ?? "");
  const isCodeChange = hasCodeLabel || descriptionReferencesWork;

  // 4. design-only
  const hasDesignLabel = labelNames.some((n) => DESIGN_LABEL_NAMES.has(n));
  const isDesignOnly =
    issue.title.startsWith("Design:") ||
    hasDesignLabel ||
    /plan only[;,.]?\s*do not write code/i.test(issue.description ?? "");

  // 5. meta-no-artifact (mutually exclusive, short-circuits)
  const hasMetaLabel = labelNames.some((n) => META_LABEL_NAMES.has(n));
  const isMetaNoArtifact =
    META_TITLE_PREFIXES.some((p) => issue.title.startsWith(p)) || hasMetaLabel;

  if (isMetaNoArtifact) {
    return ["meta-no-artifact"];
  }

  const result: ContractType[] = [];
  if (isTelegramOrigin) result.push("telegram-origin");
  if (isBridgeDispatched) result.push("bridge-dispatched");
  if (isCodeChange) result.push("code-change");
  if (isDesignOnly) result.push("design-only");

  return result;
}
