import { readFile } from "node:fs/promises";

import {
  parsePrpFixtureText,
  type ProtocolValidationIssue,
  type PrpFixture,
} from "./phase1-contract.js";

export const phase1HappyFixtureUrl = new URL(
  "../../protocol/fixtures/phase-01/happy-path.json",
  import.meta.url,
);

export class PrpFixtureValidationError extends Error {
  readonly issues: ProtocolValidationIssue[];

  constructor(issues: ProtocolValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "PrpFixtureValidationError";
    this.issues = issues;
  }
}

export async function loadPrpFixture(
  url: URL = phase1HappyFixtureUrl,
): Promise<PrpFixture> {
  const result = parsePrpFixtureText(await readFile(url, "utf8"));
  if (!result.ok) {
    throw new PrpFixtureValidationError(result.issues);
  }
  return result.fixture;
}
