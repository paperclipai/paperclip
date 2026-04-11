import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notFound } from "../errors.js";
import { assertBoard } from "./authz.js";

interface RoadmapLink {
  label: string;
  path: string;
}

interface ResolvedRoadmapLink extends RoadmapLink {
  absolutePath: string;
}

interface RoadmapItemField {
  key: string;
  value: string;
}

interface RoadmapItem {
  id: string;
  title: string;
  fields: RoadmapItemField[];
}

interface RoadmapSection {
  title: string;
  items: RoadmapItem[];
}

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(repoRoot, absolutePath));
}

function normalizeLinkTarget(target: string): string {
  return target.split("#")[0]?.split("?")[0] ?? target;
}

function resolveRepoPath(repoRoot: string, fromPath: string, target: string): string {
  const normalizedTarget = normalizeLinkTarget(target).trim();
  if (!normalizedTarget || /^https?:\/\//i.test(normalizedTarget)) {
    throw notFound("Roadmap canonical link must point to a local markdown file");
  }

  const absolutePath = path.resolve(path.dirname(fromPath), normalizedTarget);
  const normalizedRepoRoot = path.resolve(repoRoot);
  if (absolutePath !== normalizedRepoRoot && !absolutePath.startsWith(`${normalizedRepoRoot}${path.sep}`)) {
    throw notFound("Roadmap canonical link points outside the repository");
  }
  return absolutePath;
}

async function readFirstExistingFile(paths: string[]): Promise<{ path: string; content: string }> {
  for (const candidate of paths) {
    try {
      const content = await fs.readFile(candidate, "utf8");
      return { path: candidate, content };
    } catch (error) {
      const maybeErr = error as NodeJS.ErrnoException;
      if (maybeErr.code === "ENOENT") continue;
      throw error;
    }
  }
  throw notFound("Roadmap file not found. Expected doc/ROADMAP.md or ROADMAP.md.");
}

function parseRoadmapIndex(
  markdown: string,
  indexPath: string,
  repoRoot: string,
): {
    canonicalLabel: string;
    canonicalPath: string;
    links: RoadmapLink[];
  } {
  const links: ResolvedRoadmapLink[] = [];
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(linkPattern)) {
    const label = match[1]?.trim();
    const target = match[2]?.trim();
    if (!label || !target || /^https?:\/\//i.test(target)) continue;
    try {
      const absolutePath = resolveRepoPath(repoRoot, indexPath, target);
      links.push({
        label,
        path: toRepoRelativePath(repoRoot, absolutePath),
        absolutePath,
      });
    } catch {
      // Ignore links that do not resolve to local repo files.
    }
  }

  if (links.length === 0) {
    throw notFound("No canonical roadmap link found in ROADMAP.md.");
  }

  const canonical = links[0];
  return {
    canonicalLabel: canonical.label,
    canonicalPath: canonical.absolutePath,
    links: links.map(({ absolutePath: _unused, ...link }) => link),
  };
}

function parseRoadmapDocument(markdown: string): {
  title: string;
  status: string | null;
  owner: string | null;
  lastUpdated: string | null;
  contract: string[];
  sections: RoadmapSection[];
} {
  const lines = markdown.split(/\r?\n/);
  let title = "Roadmap";
  let status: string | null = null;
  let owner: string | null = null;
  let lastUpdated: string | null = null;
  const contract: string[] = [];
  const sections: RoadmapSection[] = [];

  let inContract = false;
  let currentSection: RoadmapSection | null = null;
  let currentItem: RoadmapItem | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("# ") && title === "Roadmap") {
      title = line.slice(2).trim();
      continue;
    }

    const metaMatch = line.match(/^(Status|Owner|Last Updated):\s*(.+)$/i);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const value = metaMatch[2].trim();
      if (key === "status") status = value;
      if (key === "owner") owner = value;
      if (key === "last updated") lastUpdated = value;
      continue;
    }

    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      inContract = heading.toLowerCase() === "contract";
      currentItem = null;
      currentSection = null;
      if (!inContract) {
        currentSection = { title: heading, items: [] };
        sections.push(currentSection);
      }
      continue;
    }

    if (inContract) {
      const contractMatch = line.match(/^\d+\.\s+(.+)$/);
      if (contractMatch) {
        contract.push(contractMatch[1].trim());
      }
      continue;
    }

    if (line.startsWith("### ")) {
      const heading = line.slice(4).trim();
      const itemMatch = heading.match(/^(RM-[A-Za-z0-9-]+)\s+(.+)$/);
      const id = itemMatch ? itemMatch[1] : heading;
      const itemTitle = itemMatch ? itemMatch[2] : heading;
      currentItem = { id, title: itemTitle, fields: [] };
      currentSection?.items.push(currentItem);
      continue;
    }

    if (line.startsWith("- ") && currentItem) {
      const bullet = line.slice(2).trim();
      const fieldMatch = bullet.match(/^([^:]+):\s*(.*)$/);
      if (fieldMatch) {
        currentItem.fields.push({
          key: fieldMatch[1].trim(),
          value: fieldMatch[2].trim(),
        });
      } else {
        currentItem.fields.push({ key: "Note", value: bullet });
      }
    }
  }

  return {
    title,
    status,
    owner,
    lastUpdated,
    contract,
    sections,
  };
}

export function roadmapRoutes(opts: { repoRoot?: string } = {}) {
  const router = Router();
  const repoRoot = path.resolve(opts.repoRoot ?? DEFAULT_REPO_ROOT);
  const indexCandidates = [
    path.join(repoRoot, "doc", "ROADMAP.md"),
    path.join(repoRoot, "ROADMAP.md"),
  ];

  router.get("/roadmap", async (req, res) => {
    assertBoard(req);

    const { path: indexPath, content: indexMarkdown } = await readFirstExistingFile(indexCandidates);
    const indexDetails = parseRoadmapIndex(indexMarkdown, indexPath, repoRoot);

    let roadmapMarkdown: string;
    try {
      roadmapMarkdown = await fs.readFile(indexDetails.canonicalPath, "utf8");
    } catch (error) {
      const maybeErr = error as NodeJS.ErrnoException;
      if (maybeErr.code === "ENOENT") {
        throw notFound(
          `Canonical roadmap file not found: ${toRepoRelativePath(repoRoot, indexDetails.canonicalPath)}`,
        );
      }
      throw error;
    }

    const parsed = parseRoadmapDocument(roadmapMarkdown);
    res.json({
      index: {
        path: toRepoRelativePath(repoRoot, indexPath),
        markdown: indexMarkdown,
        links: indexDetails.links,
      },
      roadmap: {
        label: indexDetails.canonicalLabel,
        path: toRepoRelativePath(repoRoot, indexDetails.canonicalPath),
        markdown: roadmapMarkdown,
        ...parsed,
      },
    });
  });

  return router;
}
