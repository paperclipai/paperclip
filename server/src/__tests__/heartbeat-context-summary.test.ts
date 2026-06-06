import { describe, expect, it } from "vitest";
import {
  buildPaperclipTaskMarkdown,
  derivePaperclipPrReview,
  evaluatePrReviewCompletionEvidence,
  mergeCoalescedContextSnapshot,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";

describe("buildPaperclipTaskMarkdown", () => {
  it("adds planning directives for assignment and comment task context", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"planning\"");
    expect(assignment).toContain("Make the plan only. Do not write code or perform implementation work.");

    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");

    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("Make the plan only.");
  });

  it("renders a GitHub PR review directive for github_pr_* wakeups", () => {
    const prReviewMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_opened",
        prNumber: 35,
        repoFullName: "Blockcast/paperclip",
        event: "pull_request",
        deliveryId: "abc-123",
        reviewKind: "pr_review",
      },
    });

    expect(prReviewMarkdown).toContain('- PR: "Blockcast/paperclip#35"');
    expect(prReviewMarkdown).toContain('- Wake reason: "github_pr_opened"');
    expect(prReviewMarkdown).toContain("GitHub PR review directive:");
    expect(prReviewMarkdown).toContain("Follow your AGENTS.md PR-review workflow");
    expect(prReviewMarkdown).toContain("Do not short-circuit to an inbox check");
    // Author-shaped directive must NOT leak into the legacy reviewer path
    // (BLO-6300: same prompt was being injected for both wake recipients).
    expect(prReviewMarkdown).not.toContain("GitHub PR review feedback directive:");
  });

  it("explicit prRole='reviewer' uses the same reviewer directive as the legacy path", () => {
    const reviewerMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_opened",
        prNumber: 35,
        repoFullName: "Blockcast/paperclip",
        event: "pull_request",
        prRole: "reviewer",
        requestCommentBody: "@ally re-review requested after the fix.",
        requestCommentAuthorLogin: "kkroo",
      },
    });
    expect(reviewerMarkdown).toContain("GitHub PR review directive:");
    expect(reviewerMarkdown).toContain("Follow your AGENTS.md PR-review workflow");
    expect(reviewerMarkdown).toContain("kkroo requested this review:");
    expect(reviewerMarkdown).toContain("@ally re-review requested after the fix.");
    expect(reviewerMarkdown).not.toContain("GitHub PR review feedback directive:");
  });

  it("renders an author-facing directive when prRole === 'author' on a review-submitted wake", () => {
    // BLO-6300: the assignee wake fired by pull_request_review.submitted
    // used to inject the reviewer-shaped "review this PR" directive into
    // the PR author's prompt. Now the author gets a directive that maps
    // to what they're supposed to do: read findings + push a follow-up.
    const authorMarkdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "BLO-5269",
        title: "Aggregator",
        workMode: null,
        description: null,
      },
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 953,
        repoFullName: "Blockcast/magma",
        prTitle: "Aggregator",
        prUrl: "https://github.com/Blockcast/magma/pull/953",
        eventUrl: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-123",
        headSha: "abc123",
        event: "pull_request_review",
        prRole: "author",
        reviewBody: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
        reviewState: "commented",
        reviewAuthorLogin: "ally",
      },
    });

    // Reviewer directive must not leak through.
    expect(authorMarkdown).not.toContain("GitHub PR review directive:");
    expect(authorMarkdown).not.toContain("Follow your AGENTS.md PR-review workflow");
    // Author directive header + reviewer attribution.
    expect(authorMarkdown).toContain("GitHub PR review feedback directive:");
    expect(authorMarkdown).toContain("ally just submitted a review on YOUR pull request (state: COMMENTED).");
    expect(authorMarkdown).toContain('- PR URL: "https://github.com/Blockcast/magma/pull/953"');
    expect(authorMarkdown).toContain('- GitHub event URL: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-123"');
    expect(authorMarkdown).toContain('- Head SHA: "abc123"');
    // Review body fence-block injected inline so the author doesn't need
    // to shell out to `gh pr view` just to read the findings.
    expect(authorMarkdown).toContain("Latest review body:");
    expect(authorMarkdown).toContain("Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.");
    // Closing instructions: push follow-up / reply / don't self-approve.
    expect(authorMarkdown).toContain("push a follow-up commit");
    expect(authorMarkdown).toContain("Do NOT close the PR or self-approve");
  });

  it("falls back to a generic author-facing directive when reviewer login / state / body are missing", () => {
    const authorMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 953,
        repoFullName: "Blockcast/magma",
        event: "pull_request_review",
        prRole: "author",
      },
    });
    expect(authorMarkdown).toContain("A reviewer just posted findings on YOUR pull request.");
    expect(authorMarkdown).not.toContain("Latest review body:");
  });

  it("adds accepted-plan continuation guidance for standard-work issues when the wake is flagged as a plan continuation", () => {
    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-2",
        identifier: "PAP-415",
        title: "Implement the fix",
        workMode: "standard",
        description: null,
      },
      acceptedPlanContinuation: true,
    });

    expect(acceptedConfirmation).toContain("Accepted plan directive:");
    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("- Work mode: \"planning\"");
  });

  it("prefers ordinary comment planning guidance over stale accepted confirmation state", () => {
    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");
    expect(commentWake).not.toContain("Create child issues from the approved plan only");
  });
});

describe("derivePaperclipPrReview", () => {
  it("returns the PR review descriptor for github_pr_* wake reasons", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubPrNumber: 35,
        githubRepoFullName: "Blockcast/paperclip",
        githubPrTitle: "Add issue refs",
        githubPrUrl: "https://github.com/Blockcast/paperclip/pull/35",
        githubEventUrl: "https://github.com/Blockcast/paperclip/pull/35",
        githubHeadSha: "abc123",
        githubEvent: "pull_request",
        githubDeliveryId: "abc-123",
        reviewKind: "pr_review",
      }),
    ).toEqual({
      wakeReason: "github_pr_opened",
      prNumber: 35,
      repoFullName: "Blockcast/paperclip",
      prTitle: "Add issue refs",
      prUrl: "https://github.com/Blockcast/paperclip/pull/35",
      eventUrl: "https://github.com/Blockcast/paperclip/pull/35",
      headSha: "abc123",
      event: "pull_request",
      deliveryId: "abc-123",
      reviewKind: "pr_review",
      prRole: null,
      reviewBody: null,
      reviewState: null,
      reviewAuthorLogin: null,
      requestCommentBody: null,
      requestCommentAuthorLogin: null,
      prAuthorLogin: null,
    });
  });

  it("surfaces the PR author login when present (BLO-9293)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubPrNumber: 235,
        githubRepoFullName: "Blockcast/Network-Operator-Portal",
        reviewKind: "pr_review",
        prRole: "reviewer",
        githubPrAuthorLogin: "allyblockcast[bot]",
      }),
    ).toMatchObject({ prAuthorLogin: "allyblockcast[bot]" });
  });

  it("surfaces prRole='author' + review body/state/login on assignee wakes (BLO-6300)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_review_submitted",
        githubPrNumber: 953,
        githubRepoFullName: "Blockcast/magma",
        githubEvent: "pull_request_review",
        prRole: "author",
        githubPrReviewBody: "Critical: silent 200 on read-only serializer.",
        githubPrReviewState: "commented",
        githubPrReviewAuthorLogin: "ally",
      }),
    ).toMatchObject({
      prRole: "author",
      reviewBody: "Critical: silent 200 on read-only serializer.",
      reviewState: "commented",
      reviewAuthorLogin: "ally",
    });
  });

  it("surfaces prRole='reviewer' on the reviewer wake", () => {
    const review = derivePaperclipPrReview({
      wakeReason: "github_pr_opened",
      githubPrNumber: 35,
      githubRepoFullName: "Blockcast/paperclip",
      prRole: "reviewer",
      githubPrReviewRequestBody: "@ally re-review requested after the fix.",
      githubPrReviewRequestAuthorLogin: "kkroo",
    });
    expect(review?.prRole).toBe("reviewer");
    expect(review?.requestCommentBody).toBe("@ally re-review requested after the fix.");
    expect(review?.requestCommentAuthorLogin).toBe("kkroo");
  });

  it("rejects unknown prRole values (defends against contextSnapshot drift)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubPrNumber: 35,
        githubRepoFullName: "Blockcast/paperclip",
        prRole: "bystander",
      })?.prRole,
    ).toBeNull();
  });

  it("coerces string-form PR numbers (operators sometimes pass strings via curl)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_ready_for_review",
        githubPrNumber: "42",
        githubRepoFullName: "Blockcast/paperclip",
      })?.prNumber,
    ).toBe(42);
  });

  it("returns null when no PR number is present", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubRepoFullName: "Blockcast/paperclip",
      }),
    ).toBeNull();
  });

  it("returns null when wakeReason is unrelated and reviewKind is not pr_review", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "issue_assigned",
        githubPrNumber: 35,
      }),
    ).toBeNull();
  });

  it("matches on reviewKind even when wakeReason is missing", () => {
    expect(
      derivePaperclipPrReview({
        reviewKind: "pr_review",
        githubPrNumber: 35,
        githubRepoFullName: "Blockcast/paperclip",
      })?.wakeReason,
    ).toBe("github_pull_request");
  });
});

describe("evaluatePrReviewCompletionEvidence", () => {
  const reviewerContext = {
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 519,
    githubRepoFullName: "Blockcast/trafficcontrol",
  };

  it("fails reviewer PR runs that exit without a posted review or explicit skip", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        resultJson: {
          summary:
            "No prior Ally review exists for head abc123; I am fetching metadata and diff now.",
        },
      }),
    ).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  it("accepts a durable posted-review marker", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary:
          "Posted the consolidated Ally review on `Blockcast/trafficcontrol#519` for head abc123.",
      }),
    ).toEqual({ status: "posted_review" });
  });

  it("accepts the live Ally consolidated comment review marker", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary:
          "Posted Ally's consolidated comment review on `Blockcast/pim-multicast-gateway#548` for head a563570063ed679e325da8da3f5376a019e7b615.",
      }),
    ).toEqual({ status: "posted_review" });
  });

  it("does not accept negated posted-review verifier text", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        resultJson: {
          title: "Could not verify that the review was posted",
          output:
            "No matching Ally review was found for head a563570063ed679e325da8da3f5376a019e7b615.",
        },
      }),
    ).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  it("does not accept generic verifier text as posted-review evidence", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "Could not verify posted Ally review for head abc123.",
      }),
    ).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  it("accepts idempotent already-reviewed skips", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "already reviewed at 2026-05-26T04:38:27Z for 86fd374dc3b456622b3852c98320f38997ef46b6",
      }),
    ).toEqual({ status: "already_reviewed" });
  });

  it("accepts archived Network-Management-Portal skips", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        {
          ...reviewerContext,
          githubRepoFullName: "Blockcast/Network-Management-Portal",
        },
        {
          summary:
            "Archive notice already present on `Blockcast/Network-Management-Portal#361`; NMP is archived, so Ally skipped review as required.",
        },
      ),
    ).toEqual({ status: "archived_repo_skipped" });
  });

  it("does not apply to author-shaped PR wakes", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        {
          ...reviewerContext,
          prRole: "author",
        },
        { summary: "" },
      ),
    ).toEqual({ status: "not_applicable" });
  });

  // BLO-8195: every entry below is a verbatim-shaped Ally completion summary
  // from a run that DID post a review but was misclassified
  // `pr_review_output_missing` by the old phrase allowlist. They must now be
  // accepted because (a) a posted/landed-review verb is present and (b) the
  // summary references the same PR target (number / head sha / repo) carried on
  // the wake context. Run IDs are recorded so the regression is traceable.
  it.each([
    // run ee48a927 — Blockcast/paperclip#227
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 227, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "4e60b6b1" },
      summary:
        "The consolidated review landed as a `COMMENTED` review at head `4e60b6b1`. PR-review wake complete. Reviewed **Blockcast/paperclip#227** and posted one consolidated, comment-only review.",
    },
    // run 4c5fc555 — Blockcast/magma#1038
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 1038, githubRepoFullName: "Blockcast/magma", githubHeadSha: "e716f54b" },
      summary:
        "Posted successfully (exit 0). The PR-review wake is complete per the completion contract. **Blockcast/magma#1038** reviewed at head `e716f54b` and posted one comment-only consolidated review.",
    },
    // run 214fad1a — Blockcast/moqtail-private#117 (no explicit "posted" verb; landed-as-COMMENTED + head sha)
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 117, githubRepoFullName: "Blockcast/moqtail-private", githubHeadSha: "d5918c4d" },
      summary:
        "Confirmed landed as **COMMENTED** at head `d5918c4d`. Review complete. Reviewed **Blockcast/moqtail-private#117**.",
    },
    // run 1af81fab — Blockcast/linux-amt#68
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 68, githubRepoFullName: "Blockcast/linux-amt", githubHeadSha: "cbedd9a1" },
      summary: "Review posted successfully on Blockcast/linux-amt#68 at head `cbedd9a1`.",
    },
    // run a7825ae3 — Blockcast/onprem-k8s#461 (verb before review noun; "Consolidated review posted")
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 461, githubRepoFullName: "Blockcast/onprem-k8s", githubHeadSha: "c08d2a6f" },
      summary:
        "Done. Consolidated review posted and confirmed. Posted a comment-only review (`state: COMMENTED`) at the correct head c08d2a6f, confirmed landed.",
    },
  ])("BLO-8195: accepts Ally's natural-language posted-review summary against the same target (%#)", ({ ctx, summary }) => {
    expect(evaluatePrReviewCompletionEvidence(ctx, { summary })).toEqual({ status: "posted_review" });
  });

  // BLO-8195: runs 57ece70a (#365) and 99510598 (#366) posted an archive notice
  // and skipped review on the retired NMP repo, but the old archived detector's
  // exact "archive notice already present" / "skipped review" strings missed
  // their actual phrasing, so they too were misclassified `pr_review_output_missing`.
  it.each([
    {
      label: "#365 skipped + posted notice",
      summary:
        "This wake was for `Blockcast/Network-Management-Portal#365`, which my AGENTS.md flags as **archived/retired** for portal work. Skipped the review (per guardrail) and posted exactly one archive notice — no prior notice existed.",
    },
    {
      label: "#366 archive notice posted, exiting without review",
      summary:
        "Archive notice posted, exiting without review. PR `Blockcast/Network-Management-Portal#366` is on the archived/retired NMP repo. Per the AGENTS.md guardrail, I did not run a review.",
    },
  ])("BLO-8195: classifies NMP archived-skip posts as archived_repo_skipped, not missing ($label)", ({ summary }) => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { ...reviewerContext, githubRepoFullName: "Blockcast/Network-Management-Portal" },
        { summary },
      ),
    ).toEqual({ status: "archived_repo_skipped" });
  });

  // BLO-8195: the broadened acceptance must never mask a real posting failure.
  it("BLO-8195: still fails a reviewer run that exited mid-fetch without posting", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 227, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "4e60b6b1" },
        { summary: "No prior Ally review exists for Blockcast/paperclip#227 at head 4e60b6b1; I am fetching metadata and diff now." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("BLO-8195: still fails when the posting is negated even though the target matches", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 227, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "4e60b6b1" },
        { summary: "Could not verify the review posted on Blockcast/paperclip#227 for head 4e60b6b1; no matching Ally review was found." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("BLO-8195: still fails when the output only states future intent to post", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 227, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "4e60b6b1" },
        { summary: "Diff fetched for Blockcast/paperclip#227 at head 4e60b6b1; I will post the consolidated review next." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // BLO-8195 hardening (Ally review of #228) — masking direction: each phrasing
  // below posted nothing, so it must stay `missing` even though it names the
  // target and contains a posted/landed token. These pin the gaps the contiguous-
  // only negation guard left open.
  const hardeningCtx = {
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 227,
    githubRepoFullName: "Blockcast/paperclip",
    githubHeadSha: "4e60b6b1",
  };
  it.each([
    { label: "non-contiguous 'not yet posted'", summary: "Diff fetched for #227 at head 4e60b6b1; the review was not yet posted." },
    { label: "'no review has been posted'", summary: "On #227 at head 4e60b6b1: no review has been posted." },
    { label: "'review never got posted'", summary: "For #227 head 4e60b6b1, the review never got posted." },
    { label: "'have not posted the review'", summary: "On #227 head 4e60b6b1 I have not posted the review." },
    { label: "bare 'submitted … for review'", summary: "Submitted the diff for review on #227 head 4e60b6b1; will await feedback." },
    { label: "credits a prior run", summary: "A review was already posted by a prior run on #227 at head 4e60b6b1." },
  ])("BLO-8195: keeps a non-posted run missing despite a posted token ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(hardeningCtx, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  it("BLO-8195: a same-repo post for a DIFFERENT PR does not satisfy the target anchor", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 228, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "aabbccdd1122" },
        { summary: "Posted review on Blockcast/paperclip#227 at head deadbeef9988." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // BLO-8195 hardening (Ally review of #228) — recall direction: these DID post and
  // match the target; an unrelated hedge must not veto them back to `missing`.
  it("BLO-8195: accepts a posted review anchored by head sha alone (no #number in text)", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 69, githubRepoFullName: "Blockcast/linux-amt", githubHeadSha: "8be14a3" },
        { summary: "Review posted successfully against head `8be14a3`." },
      ),
    ).toEqual({ status: "posted_review" });
  });

  it.each([
    { label: "incidental CI hedge", summary: "Posted the comment-only review on Blockcast/paperclip#227 at head 4e60b6b1; could not confirm CI is green yet but that is out of review scope." },
    { label: "idempotency 'no prior review' hedge", summary: "Could not find any prior Ally review for head 4e60b6b1, so I proceeded and posted the review on #227." },
  ])("BLO-8195: an unrelated hedge does not veto a genuinely posted, target-matched run ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(hardeningCtx, { summary })).toEqual({ status: "posted_review" });
  });

  // BLO-8195 recall fixes (Ally review of #229) — lock the two tradeoffs:
  // (1) "await feedback" is normal AFTER a successful post; the standalone veto was
  //     dropped so it no longer flips a posted run to missing.
  // (2) `submitted` reinstated in verb branch (b) (the `for`-guard still rejects
  //     "submitted the diff for review", asserted below).
  it.each([
    { label: "'await feedback' after a real post", summary: "Posted the review on Blockcast/paperclip#227 at head 4e60b6b1; now I await feedback." },
    { label: "'submitted my review' natural phrasing", summary: "Submitted my review on Blockcast/paperclip#227 at head 4e60b6b1." },
  ])("BLO-8195: a genuinely posted run is not vetoed by await-feedback / submitted phrasing ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(hardeningCtx, { summary })).toEqual({ status: "posted_review" });
  });

  it("BLO-8195: reinstating `submitted` does not accept 'submitted the diff for review'", () => {
    expect(
      evaluatePrReviewCompletionEvidence(hardeningCtx, {
        summary: "Submitted the diff for review on #227 head 4e60b6b1; will await feedback.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });
  // BLO-8215: a mid-run GitHub App token expiry on the publish path leaves a
  // drafted-but-unpublished review. It must be flagged with the distinct,
  // recoverable `pr_review_auth_expired` code — NOT conflated with the
  // content-failure `pr_review_output_missing`, which is not auto-retried.
  const authExpiryCtx = {
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 230,
    githubRepoFullName: "Blockcast/paperclip",
    githubHeadSha: "1672bf45",
  };

  // Real misclassified run 04f96618-af56-4c27-97cc-d8781f4750f6 (Ally, PR #230,
  // 2026-05-30T15:04Z): exited 0, drafted the review, hit `401 Bad credentials`
  // at post time, and was recorded `pr_review_output_missing`. Note the summary
  // also carries posting-negation ("could not post it") and future intent ("will
  // be reposted") — so the auth-expiry branch must take precedence over both the
  // posted-marker veto AND the final missing fallthrough.
  it("BLO-8215: classifies a real mid-run 401 token-expiry as auth_expired, not missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary:
          "I completed a full review of Blockcast/paperclip#230 (head `1672bf45`) but could not post it — the GitHub App token returned `401 Bad credentials` on both REST and GraphQL at post time (the known ~1h mid-run token-expiry pattern). The finished review is saved verbatim to memory and will be reposted on a fresh wake once auth works and the head still matches.",
      }),
    ).toMatchObject({ status: "auth_expired", errorCode: "pr_review_auth_expired" });
  });

  it.each([
    {
      label: "explicit installation-token expiry",
      summary:
        "On Blockcast/paperclip#230 at head 1672bf45 the GitHub App installation token expired mid-run, so I could not publish the consolidated review.",
    },
    {
      label: "gh CLI HTTP 401 at publish",
      summary:
        "Could not publish the review for #230 (head 1672bf45): `gh pr review` returned HTTP 401 Bad credentials.",
    },
    {
      label: "GH_TOKEN expiry before push",
      summary: "Drafted the #230 review at head 1672bf45 but GH_TOKEN expired before the push could complete.",
    },
  ])("BLO-8215: flags GitHub auth-expiry phrasings as auth_expired ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(authExpiryCtx, { summary })).toMatchObject({
      status: "auth_expired",
      errorCode: "pr_review_auth_expired",
    });
  });

  // Masking guard: a genuinely-absent review with no GitHub auth-expiry signature
  // must stay `missing`. An unrelated "expired" token (a stale lockfile) without a
  // GitHub/token/401 anchor must not be mistaken for an auth fault.
  it("BLO-8215: a non-posted run with no auth signal stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary:
          "Diff fetched for Blockcast/paperclip#230 at head 1672bf45; the review was not yet posted (a stale build lockfile had expired and I am re-running lint).",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Precedence guard: a genuinely posted review that merely mentions an earlier,
  // recovered 401 must stay `posted_review` (the posted-marker checks run first).
  it("BLO-8215: a posted review that recovered from an earlier 401 stays posted_review", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary: "Review posted successfully against head `1672bf45` after an earlier 401 Bad credentials was retried.",
      }),
    ).toEqual({ status: "posted_review" });
  });

  // BLO-9293: an INTENTIONAL self-review skip. Ally is woken to review every PR
  // including ones it authored itself; GitHub forbids self-review, so Ally exits
  // without posting. With the signed-webhook PR author confirming Ally's own bot
  // identity, the gate must accept this as `self_review_skipped` (a non-override
  // status → run stays `succeeded`), NOT `pr_review_output_missing` (which flips
  // Ally `error` and tripped the BLO-3202 sweep on three skips in a row).
  const selfReviewCtx = {
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 235,
    githubRepoFullName: "Blockcast/Network-Operator-Portal",
    githubHeadSha: "9f3ac21",
    // pull_request.user.login from the signed webhook — a GitHub App bot surfaces
    // as "<slug>[bot]"; Ally's summary names the same author as "app/<slug>".
    githubPrAuthorLogin: "allyblockcast[bot]",
  };

  it.each([
    // run 143cdf48 — Network-Operator-Portal#235
    { label: "#235 self-review not allowed", summary: "PR author is `app/allyblockcast`, so self-review is not allowed. Exiting without posting a review on Blockcast/Network-Operator-Portal#235." },
    // run 458b075f — Network-Operator-Portal#234
    { label: "#234 self-review not allowed", summary: "Reviewed Blockcast/Network-Operator-Portal#234: the PR author is `app/allyblockcast`, so self-review is not allowed; skipped." },
    // run 2455a2d9 — Network-Operator-Portal#232
    { label: "#232 skipped as self-review", summary: "PR author is `app/allyblockcast`; review was skipped as self-review for #232." },
  ])("BLO-9293: accepts an intentional self-review skip on a bot-authored PR ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(selfReviewCtx, { summary })).toEqual({
      status: "self_review_skipped",
    });
  });

  it("BLO-9293: accepts a self-review skip when the author handle is given without the app/ prefix", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { ...selfReviewCtx, githubPrAuthorLogin: "allyblockcast" },
        { summary: "Cannot review my own PR — the author is allyblockcast (this bot). Skipping #235." },
      ),
    ).toEqual({ status: "self_review_skipped" });
  });

  // Masking guard 1: the summary claims a self-review skip but the signed-webhook
  // PR author is a DIFFERENT identity (a human, or another bot). The free-text
  // claim is not corroborated, so it must NOT mask a real missing review.
  it("BLO-9293: a self-review claim whose author handle does not match the webhook author stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { ...selfReviewCtx, githubPrAuthorLogin: "some-human-dev" },
        { summary: "PR author is `app/allyblockcast`, so self-review is not allowed; skipping #235." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Masking guard 2: a self-review skip phrase with NO PR author on the wake
  // context cannot be anchored, so it stays missing (text alone is never trusted).
  it("BLO-9293: a self-review claim with no webhook PR author stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 235, githubRepoFullName: "Blockcast/Network-Operator-Portal" },
        { summary: "PR author is `app/allyblockcast`, so self-review is not allowed; skipping #235." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Negative case (issue verifying signal): a genuinely missing review — bot
  // author present, but the run produced no posted-review AND no self-review-skip
  // evidence — must still fail with `pr_review_output_missing`.
  it("BLO-9293: a real missing-output run on a bot-authored PR still fails pr_review_output_missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(selfReviewCtx, {
        summary: "No prior Ally review exists for Blockcast/Network-Operator-Portal#235 at head 9f3ac21; I am fetching metadata and diff now.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Precedence guard: Ally should still REVIEW another bot's PR (e.g. dependabot)
  // — a missing review there is a real failure, not a self-skip — and an
  // unrelated mention of "self-review" must not flip it green when the author
  // handle (dependabot) is not what any self-skip phrase cites.
  it("BLO-9293: a missing review on another bot's PR is not masked as a self-skip", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { ...selfReviewCtx, githubPrAuthorLogin: "dependabot[bot]" },
        { summary: "Fetching diff for #235 at head 9f3ac21; I will post the consolidated review next." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });
});

describe("mergeCoalescedContextSnapshot", () => {
  it("clears stale accepted-plan interaction state when merging a later ordinary comment wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBeUndefined();
    expect(merged.interactionKind).toBeUndefined();
    expect(merged.interactionStatus).toBeUndefined();
    expect(merged.continuationPolicy).toBeUndefined();
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("preserves accepted-plan interaction state for the interaction wake itself", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
  });
});

describe("summarizeHeartbeatRunContextSnapshot", () => {
  it("keeps only the small retry/linking fields needed by the client", () => {
    const summarized = summarizeHeartbeatRunContextSnapshot({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      paperclipWake: {
        comments: [
          {
            body: "x".repeat(50_000),
          },
        ],
      },
      executionStage: {
        summary: "large nested object that should not be sent back in run lists",
      },
    });

    expect(summarized).toEqual({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
    });
  });

  it("returns null when no allowed fields are present", () => {
    expect(
      summarizeHeartbeatRunContextSnapshot({
        paperclipWake: { comments: [{ body: "hello" }] },
      }),
    ).toBeNull();
  });
});

describe("summarizeHeartbeatRunListResultJson", () => {
  it("keeps only summary fields and parses numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Completed the task",
        result: "Updated three files",
        message: "",
        error: null,
        totalCostUsd: "1.25",
        costUsd: "0.75",
        costUsdCamel: "0.5",
      }),
    ).toEqual({
      summary: "Completed the task",
      result: "Updated three files",
      total_cost_usd: 1.25,
      cost_usd: 0.75,
      costUsd: 0.5,
    });
  });

  it("returns null when projected fields are empty", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "",
        result: null,
        message: undefined,
        error: "   ",
        totalCostUsd: "abc",
      }),
    ).toBeNull();
  });
});
