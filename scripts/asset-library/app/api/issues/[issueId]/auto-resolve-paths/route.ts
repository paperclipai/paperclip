// Auto-resolve workspace-path mentions in issue description into IssueDocuments.
// GLA-1102 — when an issue body cites `_default/.planning/...` paths but
// has 0 IssueDocuments attached, walk each path on the local fs, upload as
// IssueDocument, and rewrite the description to use `paperclip-doc:<key>`
// references so humans can read them in the Asset Library.

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractWorkspacePaths } from "@/lib/workspace-paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx",
  ".txt", ".log",
  ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg",
  ".html", ".htm", ".xml", ".css",
  ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".sh", ".bash", ".zsh",
  ".sql", ".graphql", ".proto",
]);

const STATIC_ROOTS = [
  "/Users/jlqueguiner/paperclip-openrunner",
];

const PROJECTS_BASE =
  "/Users/jlqueguiner/.paperclip-worktrees/instances/paperclip-openrunner/projects";
const COMPANIES_BASE =
  "/Users/jlqueguiner/.paperclip-worktrees/instances/paperclip-openrunner/companies";

let cachedRoots: string[] | null = null;

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function resolveRoots(): Promise<string[]> {
  if (cachedRoots) return cachedRoots;
  const roots = [...STATIC_ROOTS];
  for (const project of await safeReaddir(PROJECTS_BASE)) {
    const projectDir = path.join(PROJECTS_BASE, project);
    for (const agent of await safeReaddir(projectDir)) {
      roots.push(path.join(projectDir, agent, "_default"));
      roots.push(path.join(projectDir, agent));
    }
  }
  for (const company of await safeReaddir(COMPANIES_BASE)) {
    roots.push(path.join(COMPANIES_BASE, company));
  }
  cachedRoots = roots;
  return roots;
}

async function resolvePath(rawPath: string): Promise<string | null> {
  const trimmed = rawPath.trim().replace(/[.,;:]+$/, "");
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) {
    try {
      await fs.access(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }
  const roots = await resolveRoots();
  for (const root of roots) {
    const candidate = path.join(root, trimmed);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function deriveKey(filePath: string, used: Set<string>): string {
  const base = path.basename(filePath, path.extname(filePath));
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = "asset";
  if (!/^[a-z0-9]/.test(slug)) slug = `a-${slug}`;
  slug = slug.slice(0, 60);
  let candidate = slug;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = `-${n}`;
    candidate = `${slug.slice(0, 60 - suffix.length)}${suffix}`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

function isTextExtension(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function POST(
  _req: Request,
  { params }: { params: { issueId: string } },
) {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const runId = process.env.PAPERCLIP_RUN_ID ?? "";
  if (!apiUrl || !apiKey) {
    return NextResponse.json({ error: "missing_paperclip_env" }, { status: 500 });
  }

  const issueRes = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(params.issueId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" },
  );
  if (!issueRes.ok) {
    return NextResponse.json(
      { error: "issue_fetch_failed", upstreamStatus: issueRes.status },
      { status: 502 },
    );
  }
  const issue = (await issueRes.json()) as {
    id: string;
    description?: string | null;
  };
  const description = issue.description ?? "";
  const paths = extractWorkspacePaths(description);
  if (paths.length === 0) {
    return NextResponse.json(
      { error: "no_workspace_paths", message: "description has no workspace path patterns" },
      { status: 422 },
    );
  }

  const headersOut: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (runId) headersOut["X-Paperclip-Run-Id"] = runId;

  const usedKeys = new Set<string>();
  const resolved: Array<{ path: string; key: string; replacement: string }> = [];
  const failed: Array<{ path: string; reason: string }> = [];

  for (const rawPath of paths) {
    const absolute = await resolvePath(rawPath);
    if (!absolute) {
      failed.push({ path: rawPath, reason: "file not found on server" });
      continue;
    }
    if (!isTextExtension(absolute)) {
      failed.push({
        path: rawPath,
        reason: "binary file (use upload endpoint instead)",
      });
      continue;
    }
    let body: string;
    try {
      body = await fs.readFile(absolute, "utf-8");
    } catch (err) {
      failed.push({ path: rawPath, reason: `read failed: ${(err as Error).message}` });
      continue;
    }
    if (body.length > 524_288) {
      failed.push({ path: rawPath, reason: "file exceeds 512KB IssueDocument limit" });
      continue;
    }
    const key = deriveKey(absolute, usedKeys);
    const filename = path.basename(absolute);
    const upsertRes = await fetch(
      `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(issue.id)}/documents/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: headersOut,
        body: JSON.stringify({
          title: filename,
          format: "markdown",
          body,
          changeSummary: `auto-resolved from ${rawPath}`,
        }),
        cache: "no-store",
      },
    );
    if (!upsertRes.ok) {
      const text = await upsertRes.text();
      failed.push({
        path: rawPath,
        reason: `upsert failed (${upsertRes.status}): ${text.slice(0, 200)}`,
      });
      continue;
    }
    resolved.push({
      path: rawPath,
      key,
      replacement: `[${filename}](paperclip-doc:${key})`,
    });
  }

  let nextDescription = description;
  for (const r of resolved) {
    nextDescription = nextDescription.replaceAll(r.path, r.replacement);
  }
  for (const f of failed) {
    const re = new RegExp(`(?<!⚠️\\(file not found\\)\\s)${escapeRegex(f.path)}(?!\\s*⚠️)`, "g");
    nextDescription = nextDescription.replace(re, `${f.path} ⚠️(${f.reason})`);
  }

  if (nextDescription !== description) {
    const patchRes = await fetch(
      `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(issue.id)}`,
      {
        method: "PATCH",
        headers: headersOut,
        body: JSON.stringify({ description: nextDescription }),
        cache: "no-store",
      },
    );
    if (!patchRes.ok) {
      const text = await patchRes.text();
      return NextResponse.json(
        {
          ok: false,
          error: "description_patch_failed",
          upstreamStatus: patchRes.status,
          body: text.slice(0, 500),
          resolved,
          failed,
        },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    resolved: resolved.map(({ path, key }) => ({ path, key })),
    failed,
  });
}
