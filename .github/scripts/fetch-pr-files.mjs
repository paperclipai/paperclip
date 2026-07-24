#!/usr/bin/env node
/**
 * fetch-pr-files.mjs
 * Fetches the full changed-file list for a PR across GitHub pagination.
 */

export async function fetchAllPullRequestFiles(ghFetchFn, repo, prNumber, token) {
  const files = [];

  for (let page = 1; ; page += 1) {
    const batch = await ghFetchFn(
      `/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      token
    );
    files.push(...batch);

    if (batch.length < 100) {
      return files;
    }
  }
}
