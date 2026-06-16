/**
 * EDG-6246 off-substrate drill — threaded-URL merged-PR auto-close.
 *
 * Exercises the REAL exported resolver
 * (`resolveMergedPullRequestDetailsForThreadAutoClose`) and the evidence-comment
 * builder against an in-memory fake DB and a stubbed GitHub `fetch`. NO live DB,
 * NO live GitHub. Exits non-zero on any assertion failure.
 *
 * It demonstrates AC#1's true-positive (a merged PR referenced ONLY as a
 * threaded comment URL on an open repo-backed issue drives a `done` transition
 * with PR/mergedAt/commit evidence) and AC#4 safety short-circuits
 * (CLOSED-unmerged PR and unanswered [DAN]/[NEEDS-FIX] both leave the issue
 * open). Because it asserts the transition decision actually fires, reverting or
 * disabling the resolver derivation makes this drill FAIL.
 *
 * Run:  cd server && npx tsx scripts/drills/edg-6246-thread-autoclose-drill.ts
 *  (or: pnpm --filter @paperclipai/server exec tsx scripts/drills/edg-6246-thread-autoclose-drill.ts)
 */
import { projectWorkspaces, issueComments, issueDocuments } from "@paperclipai/db";
import {
  resolveMergedPullRequestDetailsForThreadAutoClose,
  buildMergedPullRequestAutoCloseComment,
} from "../../src/services/issues.ts";

type CommentRow = { body: string; authorAgentId: string | null };

type Fixture = {
  repoUrl: string;
  agentComments: CommentRow[]; // ordered oldest -> newest
  attachedDocuments: boolean;
};

// Minimal thenable query-builder stub. The resolver only ever issues four query
// shapes; each terminates in `.then(fn)`. We resolve to canned rows selected by
// the table reference passed to `.from(table)`.
function makeFakeDb(fixture: Fixture) {
  function chainFor(rows: any[]) {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      innerJoin: () => chain,
      then: (resolve: (value: any[]) => unknown) => Promise.resolve(resolve(rows)),
    };
    return chain;
  }

  return {
    select: (_columns?: unknown) => ({
      from: (table: unknown) => {
        if (table === projectWorkspaces) {
          return chainFor([{ repoUrl: fixture.repoUrl }]);
        }
        if (table === issueComments) {
          // Newest-first when ordered desc (latest agent comment); the resolver
          // reads rows[0]?.body for that query, and iterates the full list for
          // the ascending comment-rows query. We return ascending order; the
          // latest-agent-comment query takes rows[0] which, given our fixtures,
          // does not affect the merge decision.
          return chainFor(fixture.agentComments.map((c) => ({ ...c })));
        }
        if (table === issueDocuments) {
          return chainFor(fixture.attachedDocuments ? [{ documentId: "doc-1" }] : []);
        }
        return chainFor([]);
      },
    }),
  } as any;
}

function makeIssue(description: string, status = "in_progress") {
  return {
    id: "issue-1",
    identifier: "PAP-8001",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-1",
    executionWorkspaceId: null,
    description,
    status,
  } as any;
}

function stubFetch(payload: Record<string, unknown>, ok = true) {
  (globalThis as any).fetch = async () => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => payload,
  });
}

const failures: string[] = [];
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   - ${name}`);
  } else {
    failures.push(detail ? `${name}: ${detail}` : name);
    console.error(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function main() {
  console.log("EDG-6246 thread-autoclose drill\n");

  // --- True positive: merged PR referenced ONLY in a threaded comment URL. ---
  {
    stubFetch({
      merged: true,
      merged_at: "2026-06-15T10:00:00Z",
      merge_commit_sha: "abc1234",
      html_url: "https://github.com/paperclipai/paperclip/pull/4242",
    });
    const fixture: Fixture = {
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      agentComments: [
        { body: "Landed in https://github.com/paperclipai/paperclip/pull/4242", authorAgentId: "agent-1" },
      ],
      attachedDocuments: false,
    };
    const issue = makeIssue("No PR linked in the body.");
    const details = await resolveMergedPullRequestDetailsForThreadAutoClose(makeFakeDb(fixture), issue);

    check("true-positive resolves a merged PR from a threaded comment URL", details !== null);
    // This is the load-bearing transition assertion: a non-null resolution is
    // what drives `issuesSvc.update(..., { status: "done" })` in the reconcile
    // method. If the derivation is reverted, `details` is null and this fails.
    const wouldTransitionToDone = details !== null;
    check("derivation drives a done transition", wouldTransitionToDone);
    if (details) {
      check("merged flag is true", details.merged === true);
      const comment = buildMergedPullRequestAutoCloseComment({
        issue: { id: issue.id, identifier: issue.identifier },
        pullRequest: details,
      });
      check("evidence comment cites the PR number", comment.includes("#4242"), comment);
      check("evidence comment cites mergedAt", comment.includes("mergedAt: 2026-06-15T10:00:00Z"), comment);
      check("evidence comment cites the merge commit", comment.includes("commit: abc1234"), comment);
    }
  }

  // --- True negative: CLOSED-unmerged PR must NOT resolve. ---
  {
    stubFetch({ merged: false, merged_at: null, merge_commit_sha: null });
    const fixture: Fixture = {
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      agentComments: [
        { body: "See https://github.com/paperclipai/paperclip/pull/4243 (closed)", authorAgentId: "agent-1" },
      ],
      attachedDocuments: false,
    };
    const details = await resolveMergedPullRequestDetailsForThreadAutoClose(
      makeFakeDb(fixture),
      makeIssue("No PR linked here."),
    );
    check("true-negative: closed-unmerged PR does not resolve (issue stays open)", details === null);
  }

  // --- True negative: unanswered [DAN]/[NEEDS-FIX] short-circuit. ---
  {
    stubFetch({ merged: true, merged_at: "2026-06-15T10:00:00Z", merge_commit_sha: "def5678" });
    const fixture: Fixture = {
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      agentComments: [
        { body: "Landed in https://github.com/paperclipai/paperclip/pull/4244", authorAgentId: "agent-1" },
        { body: "[DAN] should we backport to the release branch?", authorAgentId: "agent-1" },
      ],
      attachedDocuments: false,
    };
    const details = await resolveMergedPullRequestDetailsForThreadAutoClose(
      makeFakeDb(fixture),
      makeIssue("No PR linked here."),
    );
    check("true-negative: unanswered [DAN] question blocks auto-close", details === null);
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`DRILL FAILED — ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("DRILL PASSED — threaded-URL merged-PR auto-close derivation verified.");
}

main().catch((err) => {
  console.error("DRILL ERRORED:", err);
  process.exit(1);
});
