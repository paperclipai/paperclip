// @vitest-environment node

/**
 * Regression guard for React error #185 ("Maximum update depth exceeded")
 * on the Issues/Tasks and Inbox pages.
 *
 * Root cause: `const { data: foo = [] } = useQuery(...)` re-evaluates the
 * `[]` literal on every render whenever `data` is `undefined` (a disabled
 * or still-loading query), handing derived useMemo/useEffect chains a new
 * array identity each render. On a default-config install (isolated
 * workspaces off), executionWorkspaces is permanently *disabled*, and
 * remoteIssueSearchResults is disabled until a search query is typed, so
 * both permanently return this unstable default — churning
 * filtered/groupedSections/flatNavItems and re-firing the row-limit /
 * selection effects that depend on them every render.
 *
 * The fix is a stable module-level empty-array constant per file
 * (EMPTY_EXECUTION_WORKSPACES / EMPTY_ISSUES) used as the useQuery
 * default instead of an inline `[]` literal.
 *
 * The runtime consequence (the render-loop crash itself) needs multiple
 * queries settling in the same synchronous update batch — a timing
 * condition this project's jsdom/vitest render harness does not
 * reproduce deterministically (confirmed while developing this fix: an
 * end-to-end Inbox render with these queries permanently disabled showed
 * identical React Profiler commit counts and identical
 * buildInboxKeyboardNavEntries call counts with and without the fix,
 * because vitest's mocked queries settle synchronously within a single
 * `act()` flush rather than racing like real network/WebSocket
 * responses). So this guard checks the fix at the source level instead:
 * it fails if either file reintroduces a raw `= []` default for one of
 * the five known query results that feed this crash, and it fails if the
 * stable replacement constants are removed or stop being used.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(here, relativePath), "utf8");
}

describe("stable useQuery defaults (regression guard for React error #185)", () => {
  it("IssuesList.tsx does not default executionWorkspaces to a raw [] literal", () => {
    const source = readSource("../components/IssuesList.tsx");

    expect(source).not.toMatch(/data:\s*executionWorkspaces\s*=\s*\[\]/);
    expect(source).toMatch(
      /const EMPTY_EXECUTION_WORKSPACES:\s*ExecutionWorkspaceSummary\[\]\s*=\s*\[\];/,
    );
    expect(source).toMatch(/data:\s*executionWorkspaces\s*=\s*EMPTY_EXECUTION_WORKSPACES/);
  });

  it("Inbox.tsx does not default executionWorkspaces/mineIssuesRaw/touchedIssuesRaw/remoteIssueSearchResults to raw [] literals", () => {
    const source = readSource("./Inbox.tsx");

    expect(source).not.toMatch(/data:\s*executionWorkspaces\s*=\s*\[\]/);
    expect(source).not.toMatch(/data:\s*mineIssuesRaw\s*=\s*\[\]/);
    expect(source).not.toMatch(/data:\s*touchedIssuesRaw\s*=\s*\[\]/);
    expect(source).not.toMatch(/data:\s*remoteIssueSearchResults\s*=\s*\[\]/);

    expect(source).toMatch(
      /const EMPTY_EXECUTION_WORKSPACES:\s*ExecutionWorkspaceSummary\[\]\s*=\s*\[\];/,
    );
    expect(source).toMatch(/const EMPTY_ISSUES:\s*Issue\[\]\s*=\s*\[\];/);

    expect(source).toMatch(/data:\s*executionWorkspaces\s*=\s*EMPTY_EXECUTION_WORKSPACES/);
    expect(source).toMatch(/data:\s*mineIssuesRaw\s*=\s*EMPTY_ISSUES/);
    expect(source).toMatch(/data:\s*touchedIssuesRaw\s*=\s*EMPTY_ISSUES/);
    expect(source).toMatch(/data:\s*remoteIssueSearchResults\s*=\s*EMPTY_ISSUES/);
  });
});
