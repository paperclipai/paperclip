import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkConfirmAcceptCascade } from "./qg-secret-binding-confirm-cascade.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const issuesRoute = join(here, "../src/routes/issues.ts");

describe("QG-SECRET-BINDING-CONFIRM-CASCADE", () => {
  it("fails the pre-fix Confirm Accept call that omits cascade", () => {
    const result = checkConfirmAcceptCascade(`
      await secretProposals.approve(issue.companyId, proposal.id, {
        resolvedByUserId,
        assertCanResolve: (lockedProposal, txDb) => assertCanResolveProposal(lockedProposal),
      });
    `);

    expect(result).toEqual({ ok: false, reason: "cascade_absent" });
  });

  it("fails an explicit cascade: false even when secretProposalId is named", () => {
    const result = checkConfirmAcceptCascade(`
      await secretProposals.approve(issue.companyId, proposal.id, {
        resolvedByUserId,
        cascade: false,
        note: proposal.secretProposalId,
      });
    `);

    expect(result).toEqual({ ok: false, reason: "cascade_absent" });
  });

  it("ignores cascade text that sits outside the approve argument", () => {
    const result = checkConfirmAcceptCascade(`
      await secretProposals.approve(issue.companyId, proposal.id, {
        resolvedByUserId,
      });
      // cascade: proposal.secretProposalId
    `);

    expect(result).toEqual({ ok: false, reason: "cascade_absent" });
  });

  it("passes cascade tied to the binding secretProposalId", () => {
    const result = checkConfirmAcceptCascade(`
      await secretProposals.approve(issue.companyId, proposal.id, {
        resolvedByUserId,
        cascade: typeof proposal.secretProposalId === "string" && proposal.secretProposalId.length > 0,
      });
    `);

    expect(result).toEqual({ ok: true, reason: "pass" });
  });

  it("passes the live Confirm Accept path in issues.ts", () => {
    const source = readFileSync(issuesRoute, "utf8");
    expect(checkConfirmAcceptCascade(source)).toEqual({ ok: true, reason: "pass" });
  });
});
