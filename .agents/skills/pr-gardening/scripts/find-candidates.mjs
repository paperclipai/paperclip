#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  chooseOriginatingIssue,
  extractPullRequestNumber,
  ghJson,
  isMissingPullRequestError,
  issueSummary,
  normalizeRepository,
  paperclipGet,
  parseArgs,
  prUrl,
  repositoryFromGh,
  writeJson,
} from "./lib.mjs";

export async function findCandidates(options) {
  const getPaperclip = options.paperclip_get ?? paperclipGet;
  const getGhJson = options.gh_json ?? ghJson;
  const repository = normalizeRepository(options.repo ?? repositoryFromGh());
  const days = Number(options.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 999) throw new Error("--days must be an integer from 1 to 999");

  const apiUrl = options.api_url ?? process.env.PAPERCLIP_API_URL;
  const apiKey = options.api_key ?? process.env.PAPERCLIP_API_KEY;
  const companyId = options.company_id ?? process.env.PAPERCLIP_COMPANY_ID;
  if (!apiUrl || !apiKey || !companyId) {
    throw new Error("PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_COMPANY_ID are required");
  }

  const contains = `github.com/${repository}/pull`;
  const limit = 200;
  const matchesPerIssue = 200;
  const issueMap = new Map();
  let offset = 0;
  let truncated = false;

  while (true) {
    const query = new URLSearchParams({
      contains,
      kind: "url",
      scope: "all",
      updatedWithin: `${days}d`,
      limit: String(limit),
      offset: String(offset),
      matchesPerIssue: String(matchesPerIssue),
    });
    const page = await getPaperclip(`/companies/${companyId}/search/extract?${query}`, { apiUrl, apiKey });
    for (const issue of page.results) issueMap.set(issue.issueId, issue);
    truncated ||= page.results.some((issue) => issue.matchesTruncated);
    if (!page.hasMore) break;
    offset += limit;
    if (offset > 5000) throw new Error("Extract-search pagination exceeded the supported 5000 issue offset");
  }
  if (truncated) throw new Error("Extract-search truncated one or more issue match sets; refusing an incomplete candidate report");

  const pullRequests = new Map();
  for (const issue of issueMap.values()) {
    for (const match of issue.matches) {
      const number = extractPullRequestNumber(match.value, repository);
      if (!number) continue;
      const entry = pullRequests.get(number) ?? { number, issueMentions: new Map() };
      const sourceIssue = entry.issueMentions.get(issue.issueId) ?? {
        ...issueSummary(issue),
        mentions: [],
        workProducts: [],
      };
      sourceIssue.mentions.push({
        value: match.value,
        field: match.field,
        label: match.label,
        source: match.source,
      });
      entry.issueMentions.set(issue.issueId, sourceIssue);
      pullRequests.set(number, entry);
    }
  }

  const uniqueIssueIds = new Set([...pullRequests.values()].flatMap((entry) => [...entry.issueMentions.keys()]));
  const issueIds = [...uniqueIssueIds];
  const workers = Array.from({ length: Math.min(8, issueIds.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < issueIds.length; index += 8) {
      const issueId = issueIds[index];
      const workProducts = await getPaperclip(`/issues/${issueId}/work-products`, { apiUrl, apiKey });
      for (const entry of pullRequests.values()) {
        const issue = entry.issueMentions.get(issueId);
        if (issue) issue.workProducts = workProducts;
      }
    }
  });
  await Promise.all(workers);

  const candidates = [];
  const closed = [];
  const unavailable = [];
  for (const entry of [...pullRequests.values()].sort((left, right) => left.number - right.number)) {
    let pullRequest;
    try {
      pullRequest = getGhJson([
        "pr",
        "view",
        String(entry.number),
        "--repo",
        repository,
        "--json",
        "number,url,title,state,isDraft,headRefOid,updatedAt",
      ]);
    } catch (error) {
      if (!isMissingPullRequestError(error)) throw error;
      unavailable.push({
        number: entry.number,
        url: prUrl(repository, entry.number),
        state: "unavailable",
        reason: "GitHub could not resolve this pull request",
      });
      continue;
    }
    const sourceIssues = [...entry.issueMentions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const candidate = {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      state: pullRequest.state.toLowerCase(),
      isDraft: pullRequest.isDraft,
      headSha: pullRequest.headRefOid,
      updatedAt: pullRequest.updatedAt,
      sourceIssues,
      originatingIssue: chooseOriginatingIssue(sourceIssues, prUrl(repository, entry.number)),
    };
    if (pullRequest.state === "OPEN") candidates.push(candidate);
    else closed.push({ number: candidate.number, url: candidate.url, state: candidate.state });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository,
    windowDays: days,
    dryRun: Boolean(options.dry_run),
    query: { contains, kind: "url", scope: "all", updatedWithin: `${days}d` },
    source: {
      issueCount: issueMap.size,
      mentionCount: [...pullRequests.values()].reduce(
        (total, entry) => total + [...entry.issueMentions.values()].reduce((sum, issue) => sum + issue.mentions.length, 0),
        0,
      ),
      distinctPullRequestCount: pullRequests.size,
      openPullRequestCount: candidates.length,
      droppedClosedPullRequests: closed,
      droppedUnavailablePullRequests: unavailable,
      truncated: false,
    },
    candidates,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { output: "candidates.json" });
  writeJson(options.output, await findCandidates(options));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
