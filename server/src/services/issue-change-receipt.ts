import { isDeepStrictEqual } from "node:util";
import type { IssueChanges } from "@paperclipai/shared";

const ISSUE_CHANGE_TEXT_BUDGET = 200;

function truncateIssueChangeText(value: unknown) {
  if (typeof value !== "string") return value;
  return Array.from(value).slice(0, ISSUE_CHANGE_TEXT_BUDGET).join("");
}

function canonicalIdArray(value: unknown): unknown {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return value;
  return [...new Set(value)].sort();
}

export function buildIssueChanges(
  existing: Record<string, unknown>,
  updated: Record<string, unknown>,
  relationChanges: {
    blockedByIssueIds?: { from: string[]; to: string[] };
    labelIds?: { from: string[]; to: string[] };
  } = {},
): IssueChanges {
  const changes: IssueChanges = {};
  const keys = new Set([...Object.keys(existing), ...Object.keys(updated)]);
  keys.delete("updatedAt");

  for (const key of keys) {
    const from = existing[key];
    const to = updated[key];
    if (isDeepStrictEqual(from, to)) continue;

    const longText =
      key === "description" ||
      (key === "title" &&
        ((typeof from === "string" && Array.from(from).length > ISSUE_CHANGE_TEXT_BUDGET) ||
          (typeof to === "string" && Array.from(to).length > ISSUE_CHANGE_TEXT_BUDGET)));
    changes[key] = longText
      ? { from: truncateIssueChangeText(from), to: truncateIssueChangeText(to), updated: true }
      : { from, to };
  }

  for (const [key, change] of Object.entries(relationChanges)) {
    const from = canonicalIdArray(change.from);
    const to = canonicalIdArray(change.to);
    if (!isDeepStrictEqual(from, to)) changes[key] = { from, to };
  }

  return changes;
}
