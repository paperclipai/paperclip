import { readFile } from "node:fs/promises";

import {
  parsePrpFixtureText,
  type ProtocolValidationIssue,
  type PrpFixture,
} from "./replay-contract.js";

export const replayHappyFixtureUrl = new URL(
  "../../protocol/fixtures/replay/happy-path.json",
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
  url: URL = replayHappyFixtureUrl,
): Promise<PrpFixture> {
  const result = parsePrpFixtureText(await readFile(url, "utf8"));
  if (!result.ok) {
    throw new PrpFixtureValidationError(result.issues);
  }
  return result.fixture;
}
