#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.PAPERCLIP_SMOKE_BASE_URL ?? null,
    companyId: process.env.PAPERCLIP_SMOKE_COMPANY_ID ?? null,
    companyName: process.env.PAPERCLIP_SMOKE_COMPANY_NAME ?? null,
    cleanupVault: process.env.PAPERCLIP_SMOKE_CLEANUP_VAULT === "true",
    waitSeconds: Number.parseInt(process.env.PAPERCLIP_SMOKE_WAIT_SECONDS ?? "90", 10) || 90,
    json: false,
  };

  for (const raw of argv) {
    if (raw === "--help" || raw === "-h") {
      args.help = true;
      continue;
    }
    if (raw === "--json") {
      args.json = true;
      continue;
    }
    if (raw === "--cleanup-vault") {
      args.cleanupVault = true;
      continue;
    }
    if (raw === "--no-cleanup-vault") {
      args.cleanupVault = false;
      continue;
    }
    if (raw.startsWith("--base-url=")) {
      args.baseUrl = raw.slice("--base-url=".length) || null;
      continue;
    }
    if (raw.startsWith("--company-id=")) {
      args.companyId = raw.slice("--company-id=".length) || null;
      continue;
    }
    if (raw.startsWith("--company-name=")) {
      args.companyName = raw.slice("--company-name=".length) || null;
      continue;
    }
    if (raw.startsWith("--wait-seconds=")) {
      args.waitSeconds = Number.parseInt(raw.slice("--wait-seconds=".length), 10) || args.waitSeconds;
      continue;
    }
    fail(`Unknown argument: ${raw}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: pnpm smoke:transcendiverse-approved-artifacts [options]

Options:
  --base-url=<url>         Override the Paperclip base URL
  --company-id=<uuid>      Target company id
  --company-name=<name>    Target company name if company id is omitted
  --wait-seconds=<n>       Wait up to n seconds for /api/health to report ok
  --cleanup-vault          Remove the raw + synthesis vault files after a successful run
  --json                   Print the final result as JSON only
  --help                   Show this message

Environment:
  PAPERCLIP_SMOKE_BASE_URL
  PAPERCLIP_SMOKE_COMPANY_ID
  PAPERCLIP_SMOKE_COMPANY_NAME
  PAPERCLIP_SMOKE_WAIT_SECONDS=90
  PAPERCLIP_SMOKE_CLEANUP_VAULT=true
  PAPERCLIP_AUTH_HEADER="Bearer ..."
  PAPERCLIP_COOKIE="session=..."
`);
}

function log(args, message) {
  if (!args.json) {
    console.log(`[transcendiverse-smoke] ${message}`);
  }
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function resolveConfigPath() {
  const paperclipHome = process.env.PAPERCLIP_HOME || path.join(os.homedir(), ".paperclip");
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID || "default";
  return {
    paperclipHome,
    instanceId,
    configPath: path.join(paperclipHome, "instances", instanceId, "config.json"),
    instanceRoot: path.join(paperclipHome, "instances", instanceId),
  };
}

async function loadSmokeConfig() {
  const resolved = resolveConfigPath();
  const config = await readJsonFile(resolved.configPath);
  const extension = config?.extensions?.transcendiverseVaultSync;

  if (!extension || typeof extension !== "object") {
    fail(`Missing extensions.transcendiverseVaultSync in ${resolved.configPath}`);
  }
  if (extension.enabled !== true) {
    fail(`transcendiverseVaultSync.enabled must be true in ${resolved.configPath}`);
  }
  if (typeof extension.vaultRoot !== "string" || extension.vaultRoot.trim().length === 0) {
    fail(`transcendiverseVaultSync.vaultRoot must be set in ${resolved.configPath}`);
  }
  if (extension.autoMergeCanonical === true) {
    fail("transcendiverseVaultSync.autoMergeCanonical must remain false for the v1 smoke test");
  }

  const host = config?.server?.host === "0.0.0.0" ? "127.0.0.1" : (config?.server?.host || "127.0.0.1");
  const port = Number(config?.server?.port || 3100);

  return {
    ...resolved,
    config,
    extension: {
      enabled: true,
      vaultRoot: path.resolve(extension.vaultRoot),
      rawImportDir: typeof extension.rawImportDir === "string" && extension.rawImportDir.length > 0
        ? extension.rawImportDir
        : "wiki/sources/internal/paperclip",
      distillationDir: typeof extension.distillationDir === "string" && extension.distillationDir.length > 0
        ? extension.distillationDir
        : "wiki/syntheses/paperclip",
      autoWriteRaw: extension.autoWriteRaw !== false,
      autoWriteDistillation: extension.autoWriteDistillation !== false,
      autoMergeCanonical: extension.autoMergeCanonical === true,
    },
    defaultBaseUrl: `http://${host}:${port}`,
  };
}

function buildRequestHeaders() {
  const headers = {
    accept: "application/json",
  };
  if (process.env.PAPERCLIP_AUTH_HEADER) {
    headers.authorization = process.env.PAPERCLIP_AUTH_HEADER;
  }
  if (process.env.PAPERCLIP_COOKIE) {
    headers.cookie = process.env.PAPERCLIP_COOKIE;
  }
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function apiRequest(method, baseUrl, apiPath, headers, body) {
  const response = await fetch(`${baseUrl}/api${apiPath}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let parsed = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (!response.ok) {
    fail(`${method} ${apiPath} failed with ${response.status}`, parsed);
  }

  return parsed;
}

async function waitForHealthyPaperclip(baseUrl, headers, args) {
  const waitMs = Math.max(0, args.waitSeconds) * 1000;
  const startedAt = Date.now();
  let lastProblem = null;
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: "GET",
        headers,
      });
      const raw = await response.text();
      let parsed = null;
      if (raw.length > 0) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }

      if (response.ok && parsed?.status === "ok") {
        return parsed;
      }

      lastProblem = {
        status: response.status,
        body: parsed,
      };
      log(args, `Waiting for Paperclip health check to turn ok (attempt ${attempt}, status ${response.status})`);
    } catch (error) {
      lastProblem = {
        error: error instanceof Error ? error.message : String(error),
      };
      log(args, `Waiting for Paperclip health check to turn ok (attempt ${attempt}, request failed)`);
    }

    if (Date.now() - startedAt >= waitMs) {
      fail(
        `Paperclip did not become healthy within ${args.waitSeconds}s. Try pnpm dev:stop, then pnpm dev:once. If embedded PostgreSQL still looks wedged, clear the stale postmaster.pid after confirming the configured embedded port is not listening.`,
        lastProblem,
      );
    }

    await sleep(2000);
  }
}

function formatTimestampForMarker(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "artifact";
}

function artifactSlug(artifact) {
  const metadata = artifact?.metadata || {};
  const issueIdentifier = typeof metadata.issueIdentifier === "string" ? metadata.issueIdentifier : null;
  const documentKey = typeof metadata.documentKey === "string" ? metadata.documentKey : null;
  const base = issueIdentifier
    ? `${issueIdentifier}${documentKey ? `-${documentKey}` : ""}`
    : `${artifact.sourceType}-${artifact.sourceId}`;
  return `${slugify(base)}-approved-v${String(artifact.version).padStart(3, "0")}`;
}

function artifactYear(artifact) {
  const approvedAt = artifact?.metadata?.approvedAt;
  const parsed = typeof approvedAt === "string" ? new Date(approvedAt) : new Date();
  return Number.isNaN(parsed.getTime()) ? String(new Date().getUTCFullYear()) : String(parsed.getUTCFullYear());
}

function expectedVaultPaths(extension, artifact) {
  const slug = artifactSlug(artifact);
  const year = artifactYear(artifact);
  return {
    raw: path.resolve(extension.vaultRoot, extension.rawImportDir, year, `${slug}.md`),
    distillation: path.resolve(extension.vaultRoot, extension.distillationDir, `${slug}-synthesis.md`),
    rawWikiLink: path.join(extension.rawImportDir, year, slug).replace(/\\/g, "/"),
  };
}

async function walkFiles(rootPath) {
  const files = new Map();

  async function visit(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await fs.stat(absolutePath);
      files.set(absolutePath, `${stats.size}|${stats.mtimeMs}`);
    }
  }

  try {
    await visit(rootPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return files;
    }
    throw error;
  }

  return files;
}

function diffSnapshots(before, after) {
  const added = [];
  const changed = [];
  const removed = [];

  for (const [filePath, signature] of after.entries()) {
    if (!before.has(filePath)) {
      added.push(filePath);
      continue;
    }
    if (before.get(filePath) !== signature) {
      changed.push(filePath);
    }
  }

  for (const filePath of before.keys()) {
    if (!after.has(filePath)) {
      removed.push(filePath);
    }
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}

async function fileHash(filePath) {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

async function resolveCompany(args, baseUrl, headers) {
  const companies = await apiRequest("GET", baseUrl, "/companies", headers);
  assert(Array.isArray(companies), "Expected /companies to return an array", companies);

  if (args.companyId) {
    const company = companies.find((entry) => entry.id === args.companyId);
    assert(company, `Company id not found: ${args.companyId}`, companies);
    return company;
  }

  if (args.companyName) {
    const exactMatches = companies.filter((entry) => entry.name === args.companyName);
    const caseInsensitiveMatches = companies.filter(
      (entry) => typeof entry.name === "string" && entry.name.toLowerCase() === args.companyName.toLowerCase(),
    );
    const matches = exactMatches.length > 0 ? exactMatches : caseInsensitiveMatches;
    assert(matches.length === 1, `Expected exactly one company named ${args.companyName}`, companies);
    return matches[0];
  }

  assert(
    companies.length === 1,
    "Multiple companies found. Set PAPERCLIP_SMOKE_COMPANY_ID or PAPERCLIP_SMOKE_COMPANY_NAME.",
    companies.map((entry) => ({ id: entry.id, name: entry.name })),
  );
  return companies[0];
}

async function createApproval(baseUrl, headers, companyId, issueId, marker, label) {
  return await apiRequest("POST", baseUrl, `/companies/${companyId}/approvals`, headers, {
    type: "request_board_approval",
    payload: {
      smokeMarker: marker,
      label,
      purpose: "transcendiverse-approved-artifact-smoke",
    },
    issueIds: [issueId],
  });
}

async function approveApproval(baseUrl, headers, approvalId, note) {
  return await apiRequest("POST", baseUrl, `/approvals/${approvalId}/approve`, headers, {
    decidedByUserId: "board",
    decisionNote: note,
  });
}

async function listArtifacts(baseUrl, headers, companyId, sourceId) {
  const artifacts = await apiRequest(
    "GET",
    baseUrl,
    `/companies/${companyId}/artifacts?sourceType=issue_document&sourceId=${encodeURIComponent(sourceId)}&limit=20`,
    headers,
  );
  assert(Array.isArray(artifacts), "Expected /artifacts to return an array", artifacts);
  return artifacts.slice().sort((left, right) => left.version - right.version);
}

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Ignore cleanup races.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const smokeConfig = await loadSmokeConfig();
  const headers = buildRequestHeaders();
  const baseUrl = args.baseUrl || smokeConfig.defaultBaseUrl;

  log(args, `Using Paperclip at ${baseUrl}`);
  log(args, `Using config ${smokeConfig.configPath}`);

  const health = await waitForHealthyPaperclip(baseUrl, headers, args);
  assert(health?.status === "ok", "Paperclip health check failed", health);
  assert(smokeConfig.extension.autoWriteRaw, "transcendiverseVaultSync.autoWriteRaw must be true");
  assert(smokeConfig.extension.autoWriteDistillation, "transcendiverseVaultSync.autoWriteDistillation must be true");

  const company = await resolveCompany(args, baseUrl, headers);
  const marker = `SMOKE-TRANSCENDIVERSE-APPROVED-ARTIFACT-${formatTimestampForMarker(new Date())}`;
  const issueTitle = `${marker} validation issue (smoke; do not use)`;
  const documentTitle = `${marker} review`;
  const vaultBefore = await walkFiles(smokeConfig.extension.vaultRoot);

  log(args, `Target company: ${company.name} (${company.id})`);
  log(args, `Creating labeled smoke issue ${issueTitle}`);

  const issue = await apiRequest("POST", baseUrl, `/companies/${company.id}/issues`, headers, {
    title: issueTitle,
    description: "Smoke-test fixture for approved document snapshot + Transcendiverse vault sync.",
    status: "in_review",
    priority: "low",
  });

  const body1 = `# ${marker} Draft
This smoke doc is intentionally editable while the issue remains in review.

- Decision candidate: freeze approved content into an immutable artifact.
- Scope candidate: sync raw and distilled vault files.
- Guardrail candidate: do not mutate canonical vault pages in v1.

- [ ] Manual canonical merge remains out of scope for v1.
`;

  const body2 = `# ${marker} Draft
This smoke doc was edited a second time while the issue is still in review.

- Decision: freeze approved content into an immutable artifact.
- Scope: sync raw and distilled vault files.
- Dedupe: unchanged approved content must not create a duplicate version.
- Guardrail: do not mutate canonical vault pages in v1.

- [ ] Manual canonical merge remains out of scope for v1.
`;

  const body3 = `# ${marker} Draft
This smoke doc changed after the first approval and should create version two.

- Decision: freeze approved content into an immutable artifact.
- Scope: sync raw and distilled vault files.
- Dedupe: unchanged approved content must not create a duplicate version.
- Versioning: changed approved content must create a new version.
- Guardrail: do not mutate canonical vault pages in v1.

- [ ] Manual canonical merge remains out of scope for v1.
- [ ] Track the second approved version separately.
`;

  const body4 = `# ${marker} Draft
This live review draft changed again after approval and must not mutate frozen approved document snapshots.

- Decision: freeze approved content into immutable artifacts.
- Scope: sync raw and distilled vault files.
- Dedupe: unchanged approved content must not create a duplicate version.
- Versioning: changed approved content must create a new version.
- Independence: the live in-review doc keeps changing after approval.

- [ ] Manual canonical merge remains out of scope for v1.
- [ ] Live review edits remain independent of approved document snapshots.
`;

  const doc1 = await apiRequest("PUT", baseUrl, `/issues/${issue.id}/documents/review`, headers, {
    title: documentTitle,
    format: "markdown",
    body: body1,
    changeSummary: "Initial smoke draft.",
  });
  const doc2 = await apiRequest("PUT", baseUrl, `/issues/${issue.id}/documents/review`, headers, {
    title: documentTitle,
    format: "markdown",
    body: body2,
    changeSummary: "Edit while still in review.",
    baseRevisionId: doc1.latestRevisionId,
  });

  const liveIssueAfterReviewEdits = await apiRequest("GET", baseUrl, `/issues/${issue.id}`, headers);
  assert(liveIssueAfterReviewEdits.status === "in_review", "Issue left in_review during live document edits", liveIssueAfterReviewEdits);
  assert(doc2.latestRevisionNumber === 2, "Expected second in-review edit to create revision 2", doc2);

  const approval1 = await createApproval(baseUrl, headers, company.id, issue.id, marker, "first-approval");
  await approveApproval(baseUrl, headers, approval1.id, "Approve version one for smoke validation.");
  const artifactsAfterV1 = await listArtifacts(baseUrl, headers, company.id, doc2.id);
  assert(artifactsAfterV1.length === 1, "Expected one approved document artifact after first approval", artifactsAfterV1);

  const artifactV1 = artifactsAfterV1[0];
  const expectedV1VaultPaths = expectedVaultPaths(smokeConfig.extension, artifactV1);
  const vaultAfterV1 = await walkFiles(smokeConfig.extension.vaultRoot);
  const vaultDiffV1 = diffSnapshots(vaultBefore, vaultAfterV1);

  assert(
    JSON.stringify(vaultDiffV1.added) === JSON.stringify([expectedV1VaultPaths.raw, expectedV1VaultPaths.distillation].sort()),
    "Expected only raw + synthesis vault files after first approval",
    vaultDiffV1,
  );
  assert(vaultDiffV1.changed.length === 0, "Unexpected vault file mutations after first approval", vaultDiffV1);
  assert(vaultDiffV1.removed.length === 0, "Unexpected vault file removals after first approval", vaultDiffV1);

  const rawV1Hash = await fileHash(expectedV1VaultPaths.raw);
  const artifactV1Hash = await fileHash(artifactV1.storagePath);
  assert(rawV1Hash === artifactV1Hash, "Raw vault file does not match the immutable artifact", {
    rawVaultPath: expectedV1VaultPaths.raw,
    artifactPath: artifactV1.storagePath,
  });

  const distillationV1Content = await fs.readFile(expectedV1VaultPaths.distillation, "utf8");
  assert(
    distillationV1Content.includes(`rawArtifact: "${expectedV1VaultPaths.rawWikiLink}"`) &&
      distillationV1Content.includes(`[[${expectedV1VaultPaths.rawWikiLink}]]`),
    "Distillation note does not link back to the raw approved document snapshot",
    { distillationPath: expectedV1VaultPaths.distillation, rawWikiLink: expectedV1VaultPaths.rawWikiLink },
  );

  const artifactV1HashBeforeLaterEdits = await fileHash(artifactV1.storagePath);

  const approval2 = await createApproval(baseUrl, headers, company.id, issue.id, marker, "unchanged-reapproval");
  await approveApproval(baseUrl, headers, approval2.id, "Approve unchanged content to verify dedupe.");
  const artifactsAfterDedupe = await listArtifacts(baseUrl, headers, company.id, doc2.id);
  const vaultAfterDedupe = await walkFiles(smokeConfig.extension.vaultRoot);
  const vaultDiffDedupe = diffSnapshots(vaultAfterV1, vaultAfterDedupe);

  assert(artifactsAfterDedupe.length === 1, "Unchanged re-approval created a duplicate artifact", artifactsAfterDedupe);
  assert(vaultDiffDedupe.added.length === 0 && vaultDiffDedupe.changed.length === 0 && vaultDiffDedupe.removed.length === 0, "Unchanged re-approval mutated vault output", vaultDiffDedupe);

  const doc3 = await apiRequest("PUT", baseUrl, `/issues/${issue.id}/documents/review`, headers, {
    title: documentTitle,
    format: "markdown",
    body: body3,
    changeSummary: "Edit after first approval to create version two.",
    baseRevisionId: doc2.latestRevisionId,
  });
  assert(doc3.latestRevisionNumber === 3, "Expected changed draft to create revision 3", doc3);
  const artifactV1HashAfterChangedDraft = await fileHash(artifactV1.storagePath);
  assert(artifactV1HashAfterChangedDraft === artifactV1HashBeforeLaterEdits, "Live draft edit mutated artifact version one");

  const approval3 = await createApproval(baseUrl, headers, company.id, issue.id, marker, "changed-reapproval");
  await approveApproval(baseUrl, headers, approval3.id, "Approve changed content to create version two.");
  const artifactsAfterV2 = await listArtifacts(baseUrl, headers, company.id, doc3.id);
  assert(artifactsAfterV2.length === 2, "Expected two approved document artifact versions after changed approval", artifactsAfterV2);

  const artifactV2 = artifactsAfterV2.find((artifact) => artifact.version === 2);
  assert(artifactV2, "Missing artifact version two after changed approval", artifactsAfterV2);

  const expectedV2VaultPaths = expectedVaultPaths(smokeConfig.extension, artifactV2);
  const vaultAfterV2 = await walkFiles(smokeConfig.extension.vaultRoot);
  const vaultDiffV2 = diffSnapshots(vaultAfterDedupe, vaultAfterV2);

  assert(
    JSON.stringify(vaultDiffV2.added) === JSON.stringify([expectedV2VaultPaths.raw, expectedV2VaultPaths.distillation].sort()),
    "Expected only raw + synthesis vault files after changed approval",
    vaultDiffV2,
  );
  assert(vaultDiffV2.changed.length === 0, "Unexpected vault file mutations after changed approval", vaultDiffV2);
  assert(vaultDiffV2.removed.length === 0, "Unexpected vault file removals after changed approval", vaultDiffV2);

  const rawV2Hash = await fileHash(expectedV2VaultPaths.raw);
  const artifactV2Hash = await fileHash(artifactV2.storagePath);
  assert(rawV2Hash === artifactV2Hash, "Raw version two vault file does not match the immutable artifact", {
    rawVaultPath: expectedV2VaultPaths.raw,
    artifactPath: artifactV2.storagePath,
  });

  const distillationV2Content = await fs.readFile(expectedV2VaultPaths.distillation, "utf8");
  assert(
    distillationV2Content.includes(`rawArtifact: "${expectedV2VaultPaths.rawWikiLink}"`) &&
      distillationV2Content.includes(`[[${expectedV2VaultPaths.rawWikiLink}]]`),
    "Version two distillation note does not link back to the raw approved document snapshot",
    { distillationPath: expectedV2VaultPaths.distillation, rawWikiLink: expectedV2VaultPaths.rawWikiLink },
  );

  const artifactV2HashBeforeFinalEdit = await fileHash(artifactV2.storagePath);

  const doc4 = await apiRequest("PUT", baseUrl, `/issues/${issue.id}/documents/review`, headers, {
    title: documentTitle,
    format: "markdown",
    body: body4,
    changeSummary: "Live review edit after the second approval.",
    baseRevisionId: doc3.latestRevisionId,
  });
  assert(doc4.latestRevisionNumber === 4, "Expected final live draft to create revision 4", doc4);

  const liveDocAfterFinalEdit = await apiRequest("GET", baseUrl, `/issues/${issue.id}/documents/review`, headers);
  const vaultAfterFinalEdit = await walkFiles(smokeConfig.extension.vaultRoot);
  const vaultDiffFinalEdit = diffSnapshots(vaultAfterV2, vaultAfterFinalEdit);
  const artifactV1HashAfterFinalEdit = await fileHash(artifactV1.storagePath);
  const artifactV2HashAfterFinalEdit = await fileHash(artifactV2.storagePath);
  const artifactV1Content = await fs.readFile(artifactV1.storagePath, "utf8");
  const artifactV2Content = await fs.readFile(artifactV2.storagePath, "utf8");

  assert(artifactV1HashAfterFinalEdit === artifactV1HashBeforeLaterEdits, "Final live edit mutated artifact version one");
  assert(artifactV2HashAfterFinalEdit === artifactV2HashBeforeFinalEdit, "Final live edit mutated artifact version two");
  assert(vaultDiffFinalEdit.added.length === 0 && vaultDiffFinalEdit.changed.length === 0 && vaultDiffFinalEdit.removed.length === 0, "Final live edit mutated vault files without approval", vaultDiffFinalEdit);
  assert(liveDocAfterFinalEdit.body.includes("must not mutate frozen approved document snapshots"), "Final live doc did not persist the post-approval edit");
  assert(!artifactV1Content.includes("must not mutate frozen approved document snapshots"), "Artifact version one contains post-approval live edits");
  assert(!artifactV2Content.includes("must not mutate frozen approved document snapshots"), "Artifact version two contains post-approval live edits");

  const createdVaultFiles = [expectedV1VaultPaths.raw, expectedV1VaultPaths.distillation, expectedV2VaultPaths.raw, expectedV2VaultPaths.distillation];
  if (args.cleanupVault) {
    for (const filePath of createdVaultFiles) {
      await removeIfExists(filePath);
    }
  }

  const result = {
    passed: true,
    baseUrl,
    configPath: smokeConfig.configPath,
    company: {
      id: company.id,
      name: company.name,
    },
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
    },
    document: {
      id: doc4.id,
      key: doc4.key,
      latestRevisionNumber: doc4.latestRevisionNumber,
    },
    approvals: {
      v1ApprovalId: approval1.id,
      dedupeApprovalId: approval2.id,
      v2ApprovalId: approval3.id,
    },
    artifacts: [
      {
        id: artifactV1.id,
        version: artifactV1.version,
        storagePath: artifactV1.storagePath,
        contentHash: artifactV1.contentHash,
      },
      {
        id: artifactV2.id,
        version: artifactV2.version,
        storagePath: artifactV2.storagePath,
        contentHash: artifactV2.contentHash,
      },
    ],
    vaultFiles: createdVaultFiles,
    cleanupVault: args.cleanupVault,
    checks: {
      editableInReview: true,
      approvedCreatesV1: true,
      unchangedReapprovalDedupes: true,
      changedApprovalCreatesV2: true,
      laterLiveEditsDoNotMutateArtifacts: true,
      noCanonicalVaultMutation: true,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("");
  console.log("Approved document snapshot smoke test passed.");
  console.log(`Company: ${company.name} (${company.id})`);
  console.log(`Issue: ${issue.identifier} (${issue.id})`);
  console.log(`Artifact v1: ${artifactV1.storagePath}`);
  console.log(`Artifact v2: ${artifactV2.storagePath}`);
  console.log(`Vault raw v1: ${expectedV1VaultPaths.raw}`);
  console.log(`Vault synthesis v1: ${expectedV1VaultPaths.distillation}`);
  console.log(`Vault raw v2: ${expectedV2VaultPaths.raw}`);
  console.log(`Vault synthesis v2: ${expectedV2VaultPaths.distillation}`);
  if (args.cleanupVault) {
    console.log("Vault cleanup: removed the four smoke-generated vault files after verification.");
  } else {
    console.log("Vault cleanup: skipped. Pass --cleanup-vault to remove the smoke-generated vault files after verification.");
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Approved artifact smoke test failed: ${message}`);
  if (error && typeof error === "object" && "details" in error && error.details !== undefined) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
}
