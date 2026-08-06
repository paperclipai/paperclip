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
  resolveAuthorAllowlist,
  writeJson,
} from "./lib.mjs";

export async function findCandidates(options) {
  const getPaperclip = options.paperclip_get ?? paperclipGet;
  const getGhJson = options.gh_json ?? ghJson;
  const repository = normalizeRepository(options.repo ?? repositoryFromGh());
  const authorAllowlist = resolveAuthorAllowlist(options, getGhJson);
  const days = Number(options.days ?? 14);
  if (!Number.isInteger(days) || days < 1 || days > 999) throw new Error("--days must be an integer from 1 to 999");
  const now = options.now ? new Date(options.now) : new Date();
  const windowStartMs = now.getTime() - days * 24 * 60 * 60 * 1000;

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
    if (!page.hasMore) break;
    offset += limit;
    if (offset > 5000) throw new Error("Extract-search pagination exceeded the supported 5000 issue offset");
  }
  // Issues that hit the per-issue match cap (typically digest/QA issues that
  // enumerate hundreds of PR URLs) lose mentions beyond the cap. That only
  // weakens attribution for those issues, so record them and continue rather
  // than refusing the whole run.
  const truncatedIssues = [...issueMap.values()]
    .filter((issue) => issue.matchesTruncated)
    .map((issue) => ({ issueId: issue.issueId, identifier: issue.identifier, title: issue.title }));
  if (truncatedIssues.length > 0) {
    process.stderr.write(
      `warning: ${truncatedIssues.length} issue(s) exceeded the ${matchesPerIssue}-match extract cap; PR mentions beyond the cap were not scanned: ${truncatedIssues.map((issue) => issue.identifier ?? issue.issueId).join(", ")}\n`,
    );
  }

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
  const community = [];
  const stale = [];
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
        "number,url,title,author,state,isDraft,headRefOid,updatedAt",
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
    const author = pullRequest.author?.login ?? null;
    if (authorAllowlist && !authorAllowlist.includes(author?.toLowerCase())) {
      community.push({
        number: entry.number,
        url: prUrl(repository, entry.number),
        author,
        state: pullRequest.state.toLowerCase(),
      });
      continue;
    }
    const sourceIssues = [...entry.issueMentions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const candidate = {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      author,
      state: pullRequest.state.toLowerCase(),
      isDraft: pullRequest.isDraft,
      headSha: pullRequest.headRefOid,
      updatedAt: pullRequest.updatedAt,
      sourceIssues,
      originatingIssue: chooseOriginatingIssue(sourceIssues, prUrl(repository, entry.number)),
    };
    if (pullRequest.state !== "OPEN") {
      closed.push({ number: candidate.number, url: candidate.url, state: candidate.state });
    } else if (new Date(pullRequest.updatedAt).getTime() < windowStartMs) {
      // A recently active issue can mention a long-dormant PR (old digests,
      // salvage discussions); gardening only drives PRs with activity inside
      // the window.
      stale.push({ number: candidate.number, url: candidate.url, author, updatedAt: pullRequest.updatedAt });
    } else {
      candidates.push(candidate);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository,
    windowDays: days,
    dryRun: Boolean(options.dry_run),
    query: { contains, kind: "url", scope: "all", updatedWithin: `${days}d`, authors: authorAllowlist },
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
      droppedCommunityPullRequests: community,
      droppedStalePullRequests: stale,
      truncated: truncatedIssues.length > 0,
      truncatedIssues,
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
