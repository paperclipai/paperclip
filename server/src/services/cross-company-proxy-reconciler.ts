import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { companies, issues, type Db } from "@paperclipai/db";
import { issueService } from "./issues.js";

const OPEN_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const PROXY_SENTINELS = [
  "Blocked-by issues must belong to the same company",
  "foreign blocker locally",
  "cross-company",
];
const ISSUE_LINK_RE = /\[([A-Z][A-Z0-9]*-\d+)\]\(\/([A-Z][A-Z0-9]*)\/issues\/([A-Z][A-Z0-9]*-\d+)\)/g;

type OpenStatus = typeof OPEN_STATUSES[number];

type ProxyIssueRow = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: OpenStatus;
  companyId: string;
  companyPrefix: string;
  parentId: string;
};

export type ParsedCrossCompanyProxy = {
  remoteIdentifier: string;
  remotePrefix: string;
};

export type CrossCompanyProxyDuplicateFinding = {
  parentId: string;
  parentIdentifier: string | null;
  childIdentifiers: string[];
  remoteIdentifiers: string[];
};

export type CrossCompanyProxyReconcilerSummary = {
  scannedOpenIssues: number;
  proxyCandidates: number;
  closableCount: number;
  closed: string[];
  duplicateParentCount: number;
  duplicateFindings: CrossCompanyProxyDuplicateFinding[];
};

function issueText(description: string | null | undefined) {
  return typeof description === "string" ? description : "";
}

export function parseCrossCompanyProxy(description: string | null | undefined, localPrefix: string): ParsedCrossCompanyProxy | null {
  const text = issueText(description);
  if (!text) return null;
  if (!PROXY_SENTINELS.some((sentinel) => text.includes(sentinel))) return null;

  const foreignIds = new Map<string, string>();
  for (const match of text.matchAll(ISSUE_LINK_RE)) {
    const hrefPrefix = match[2];
    const identifier = match[3];
    if (!hrefPrefix || !identifier) continue;
    if (hrefPrefix === localPrefix) continue;
    foreignIds.set(identifier, hrefPrefix);
  }
  if (foreignIds.size !== 1) return null;
  const [remoteIdentifier, remotePrefix] = [...foreignIds.entries()][0];
  if (!remoteIdentifier || !remotePrefix) return null;
  return { remoteIdentifier, remotePrefix };
}

export function findDuplicateParentProxies(
  input: Array<ProxyIssueRow & { parsed: ParsedCrossCompanyProxy }>,
  parentIdentifierById: Map<string, string | null>,
) {
  const grouped = new Map<string, Array<ProxyIssueRow & { parsed: ParsedCrossCompanyProxy }>>();
  for (const item of input) {
    const bucket = grouped.get(item.parentId) ?? [];
    bucket.push(item);
    grouped.set(item.parentId, bucket);
  }

  const findings: CrossCompanyProxyDuplicateFinding[] = [];
  for (const [parentId, rows] of grouped.entries()) {
    if (rows.length <= 1) continue;
    findings.push({
      parentId,
      parentIdentifier: parentIdentifierById.get(parentId) ?? null,
      childIdentifiers: rows.map((row) => row.identifier ?? row.id).sort(),
      remoteIdentifiers: rows.map((row) => row.parsed.remoteIdentifier).sort(),
    });
  }
  return findings.sort((a, b) => (a.parentIdentifier ?? a.parentId).localeCompare(b.parentIdentifier ?? b.parentId));
}

export async function reconcileCrossCompanyProxyIssues(
  db: Db,
  input: { companyId?: string | null; apply?: boolean } = {},
): Promise<CrossCompanyProxyReconcilerSummary> {
  const svc = issueService(db);
  const proxyRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      companyId: issues.companyId,
      companyPrefix: companies.issuePrefix,
      parentId: issues.parentId,
    })
    .from(issues)
    .innerJoin(companies, eq(companies.id, issues.companyId))
    .where(and(
      inArray(issues.status, [...OPEN_STATUSES]),
      eq(issues.originKind, "manual"),
      isNotNull(issues.parentId),
      isNull(issues.hiddenAt),
      input.companyId ? eq(issues.companyId, input.companyId) : undefined,
    ));

  const candidates = proxyRows
    .map((row) => {
      const parsed = parseCrossCompanyProxy(row.description, row.companyPrefix);
      if (!parsed || !row.parentId) return null;
      return {
        ...row,
        status: row.status as OpenStatus,
        parentId: row.parentId,
        parsed,
      };
    })
    .filter((row): row is ProxyIssueRow & { parsed: ParsedCrossCompanyProxy } => row !== null);

  const parentIds = [...new Set(candidates.map((row) => row.parentId))];
  const parentRows = parentIds.length === 0
    ? []
    : await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(inArray(issues.id, parentIds));
  const parentIdentifierById = new Map(parentRows.map((row) => [row.id, row.identifier ?? null]));

  const remoteIdentifiers = [...new Set(candidates.map((row) => row.parsed.remoteIdentifier))];
  const remoteRows = remoteIdentifiers.length === 0
    ? []
    : await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
      })
      .from(issues)
      .where(inArray(issues.identifier, remoteIdentifiers));
  const remoteByIdentifier = new Map(remoteRows.map((row) => [row.identifier ?? "", row]));

  const duplicateFindings = findDuplicateParentProxies(candidates, parentIdentifierById);
  const closable = candidates.filter((row) => {
    const remote = remoteByIdentifier.get(row.parsed.remoteIdentifier);
    return Boolean(remote && TERMINAL_STATUSES.has(remote.status));
  });

  const closed: string[] = [];
  if (input.apply) {
    for (const row of closable) {
      const remote = remoteByIdentifier.get(row.parsed.remoteIdentifier);
      if (!remote) continue;
      await svc.update(row.id, { status: "done" });
      await svc.addComment(
        row.id,
        [
          "Status: done",
          "",
          "- Auto-closed by cross-company proxy reconciler.",
          `- Worked surface: proxy child for foreign issue \`${row.parsed.remoteIdentifier}\`.`,
          `- Verification: foreign issue \`${row.parsed.remoteIdentifier}\` is terminal (\`${remote.status}\`) in the local DB view.`,
          "- Next owner/action: none on this proxy; if the parent still needs a dateless foreign wait, use the external-gate convention instead of minting more proxy children.",
        ].join("\n"),
        {},
        { authorType: "system" },
      );
      closed.push(row.identifier ?? row.id);
    }
  }

  return {
    scannedOpenIssues: proxyRows.length,
    proxyCandidates: candidates.length,
    closableCount: closable.length,
    closed,
    duplicateParentCount: duplicateFindings.length,
    duplicateFindings,
  };
}
