import fs from "node:fs/promises";
import path from "node:path";
import { notFound, unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  listSandboxedFilesRecursive,
  normalizeSandboxRelativePath,
  readSandboxedFile,
  type SandboxedFile,
  type SandboxedFileDetail,
} from "../lib/sandboxed-fs.js";

type AgentLike = {
  id: string;
  companyId: string;
};

export type AgentBrainSection = {
  /** Stable key the UI uses to group entries: `life`, `memory`, or `MEMORY.md`. */
  key: string;
  /** Absolute filesystem root for this section. */
  root: string;
  /** True if `root` exists on disk and is the expected file/directory type. */
  exists: boolean;
  /** True for the single-file `MEMORY.md` section, false for the directory sections. */
  isFile: boolean;
  /** Files discovered under `root`. For the single-file section this is at most one entry. */
  files: SandboxedFile[];
};

export type AgentBrainManifest = {
  agentId: string;
  companyId: string;
  /** AGENT_HOME (the parent of the section roots), useful for the UI to render breadcrumbs. */
  agentHome: string;
  sections: AgentBrainSection[];
};

export type AgentBrainFileDetail = SandboxedFileDetail & {
  /** Which allow-listed section the file lives in (`life`, `memory`, or `MEMORY.md`). */
  section: string;
};

/** The three roots that make up Layer B. Order is preserved in the manifest. */
export const AGENT_BRAIN_SECTIONS = [
  { key: "life", isFile: false },
  { key: "memory", isFile: false },
  { key: "MEMORY.md", isFile: true },
] as const;

type Section = typeof AGENT_BRAIN_SECTIONS[number];

function resolveAgentHome(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
  );
}

function resolveSectionRoot(agent: AgentLike, section: Section): string {
  return path.resolve(resolveAgentHome(agent), section.key);
}

function findSectionByKey(key: string): Section | null {
  return AGENT_BRAIN_SECTIONS.find((section) => section.key === key) ?? null;
}

export function agentBrainService() {
  async function describeSection(agent: AgentLike, section: Section): Promise<AgentBrainSection> {
    const root = resolveSectionRoot(agent, section);
    if (section.isFile) {
      const stat = await fs.stat(root).catch(() => null);
      if (!stat?.isFile()) {
        return { key: section.key, root, exists: false, isFile: true, files: [] };
      }
      return {
        key: section.key,
        root,
        exists: true,
        isFile: true,
        files: [
          { path: section.key, size: stat.size, mtime: stat.mtime.toISOString() },
        ],
      };
    }
    const files = await listSandboxedFilesRecursive(root);
    return {
      key: section.key,
      root,
      exists: files !== null,
      isFile: false,
      files: files ?? [],
    };
  }

  async function getManifest(agent: AgentLike): Promise<AgentBrainManifest> {
    const sections = await Promise.all(
      AGENT_BRAIN_SECTIONS.map((section) => describeSection(agent, section)),
    );
    return {
      agentId: agent.id,
      companyId: agent.companyId,
      agentHome: resolveAgentHome(agent),
      sections,
    };
  }

  async function readFile(agent: AgentLike, requestedPath: string): Promise<AgentBrainFileDetail> {
    const trimmed = typeof requestedPath === "string" ? requestedPath.trim() : "";
    if (!trimmed) {
      throw unprocessable("Query parameter 'path' is required");
    }
    const normalized = normalizeSandboxRelativePath(trimmed);
    const slashIndex = normalized.indexOf("/");
    const sectionKey = slashIndex === -1 ? normalized : normalized.slice(0, slashIndex);
    const remainder = slashIndex === -1 ? "" : normalized.slice(slashIndex + 1);
    const section = findSectionByKey(sectionKey);
    if (!section) {
      throw unprocessable(
        "Brain file paths must begin with one of: life, memory, MEMORY.md",
      );
    }
    if (section.isFile) {
      if (remainder) {
        throw unprocessable(`Section '${section.key}' is a single file; nested paths are not allowed`);
      }
      const detail = await readSandboxedFile(resolveAgentHome(agent), section.key);
      if (!detail) throw notFound("Brain file not found");
      return { ...detail, section: section.key };
    }
    if (!remainder) {
      throw unprocessable(`Section '${section.key}' requires a sub-path (e.g. '${section.key}/foo.md')`);
    }
    const detail = await readSandboxedFile(resolveSectionRoot(agent, section), remainder);
    if (!detail) throw notFound("Brain file not found");
    return { ...detail, section: section.key };
  }

  return {
    getManifest,
    readFile,
    /** Test/inspection helper: expose the section roots so callers can stage fixtures. */
    resolveSectionRoot: (agent: AgentLike, key: string) => {
      const section = findSectionByKey(key);
      if (!section) throw unprocessable(`Unknown brain section '${key}'`);
      return resolveSectionRoot(agent, section);
    },
    resolveAgentHome,
  };
}

export type AgentBrainService = ReturnType<typeof agentBrainService>;
