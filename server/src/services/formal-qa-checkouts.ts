import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  formalQaCheckouts,
  formalQaPreparations,
  projectWorkspaces,
} from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { conflict, notFound } from "../errors.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const SHA40_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

type PreparationRow = typeof formalQaPreparations.$inferSelect;
type CheckoutRow = typeof formalQaCheckouts.$inferSelect;

type GitResult = { stdout: string; stderr: string; code: number };

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      ...args,
    ], {
      cwd,
      env: isolatedGitEnvironment(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 };
  } catch (error) {
    const child = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: child.stdout?.trim() ?? "",
      stderr: child.stderr?.trim() ?? "",
      code: typeof child.code === "number" ? child.code : 1,
    };
  }
}

async function gitOrThrow(args: string[], cwd: string, message: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw conflict(message, { code: "formal_qa_checkout_verification_failed" });
  }
  return result.stdout;
}

function canonicalRepository(value: string): string | null {
  const trimmed = value.trim();
  if (REPOSITORY_RE.test(trimmed)) return trimmed.toLowerCase();

  const ssh = trimmed.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (ssh && REPOSITORY_RE.test(ssh[1]!)) return ssh[1]!.replace(/\.git$/i, "").toLowerCase();

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const name = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return REPOSITORY_RE.test(name) ? name.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function pathKind(value: string): Promise<"missing" | "directory" | "symlink" | "other"> {
  try {
    const stats = await fs.lstat(value);
    if (stats.isSymbolicLink()) return "symlink";
    return stats.isDirectory() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function ensureDirectoryNoSymlink(value: string): Promise<void> {
  const kind = await pathKind(value);
  if (kind !== "directory") {
    throw conflict("Formal-QA checkout path is not a trusted directory", {
      code: "formal_qa_checkout_path_untrusted",
    });
  }
}

function checkoutDigest(input: {
  preparation: PreparationRow;
  repoRoot: string;
  checkoutPath: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    preparationId: input.preparation.id,
    repository: input.preparation.repository,
    headSha: input.preparation.headSha,
    treeSha: input.preparation.treeSha,
    repoRoot: input.repoRoot,
    checkoutPath: input.checkoutPath,
  })).digest("hex");
}

async function assertExactCheckout(input: {
  repoRoot: string;
  checkoutPath: string;
  preparation: PreparationRow;
}): Promise<void> {
  await ensureDirectoryNoSymlink(input.checkoutPath);
  const registered = await gitOrThrow(["worktree", "list", "--porcelain"], input.repoRoot, "Formal-QA checkout is not registered");
  const expectedPath = await fs.realpath(input.checkoutPath);
  const paths = registered.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const registeredPaths = await Promise.all(paths.map((value) => fs.realpath(value).catch(() => null)));
  if (!registeredPaths.includes(expectedPath)) {
    throw conflict("Formal-QA checkout is not registered with its source repository", {
      code: "formal_qa_checkout_verification_failed",
    });
  }

  const head = await gitOrThrow(["rev-parse", "--verify", "HEAD^{commit}"], input.checkoutPath, "Formal-QA checkout does not resolve to a commit");
  const tree = await gitOrThrow(["rev-parse", "--verify", "HEAD^{tree}"], input.checkoutPath, "Formal-QA checkout does not resolve to an exact tree");
  const branch = await runGit(["symbolic-ref", "--quiet", "HEAD"], input.checkoutPath);
  const dirty = await gitOrThrow(["status", "--porcelain", "--untracked-files=all"], input.checkoutPath, "Formal-QA checkout status cannot be verified");
  if (head !== input.preparation.headSha || tree !== input.preparation.treeSha || branch.code === 0 || dirty !== "") {
    throw conflict("Formal-QA checkout is not the sealed detached, clean exact head", {
      code: "formal_qa_checkout_verification_failed",
    });
  }
}

export type FormalQaCheckoutService = ReturnType<typeof formalQaCheckoutService>;

/**
 * Materializes a preparation only as an audited detached Git worktree.
 * It intentionally has no HTTP route: a later privileged issuer must call it
 * after it has independently authenticated the authority receipt.
 */
export function formalQaCheckoutService(db: Db, options?: { instanceRoot?: string }) {
  const instanceRoot = path.resolve(options?.instanceRoot ?? resolvePaperclipInstanceRoot());

  async function loadPreparation(preparationId: string) {
    const [preparation] = await db.select().from(formalQaPreparations)
      .where(eq(formalQaPreparations.id, preparationId)).limit(1);
    if (!preparation) throw notFound("Formal-QA preparation not found");
    if (preparation.status !== "prepared" || preparation.expiresAt.getTime() <= Date.now()) {
      throw conflict("Formal-QA preparation is not eligible for exact checkout", {
        code: "formal_qa_preparation_not_eligible",
      });
    }
    const [workspace] = await db.select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(and(
        eq(projectWorkspaces.id, preparation.projectWorkspaceId),
        eq(projectWorkspaces.companyId, preparation.companyId),
        eq(projectWorkspaces.projectId, preparation.projectId),
      )).limit(1);
    if (!workspace?.cwd || !path.isAbsolute(workspace.cwd)) {
      throw conflict("Formal-QA preparation has no local source repository", {
        code: "formal_qa_checkout_source_unavailable",
      });
    }
    return { preparation, cwd: workspace.cwd };
  }

  return {
    getByPreparationId: async (preparationId: string): Promise<CheckoutRow | null> => {
      const [checkout] = await db.select().from(formalQaCheckouts)
        .where(eq(formalQaCheckouts.preparationId, preparationId)).limit(1);
      return checkout ?? null;
    },

    materialize: async ({ preparationId }: { preparationId: string }) => db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_checkout:${preparationId}`}, 0))`);
      const [preparation] = await tx.select().from(formalQaPreparations)
        .where(eq(formalQaPreparations.id, preparationId)).limit(1);
      if (!preparation) throw notFound("Formal-QA preparation not found");
      if (preparation.status !== "prepared" || preparation.expiresAt.getTime() <= Date.now()) {
        throw conflict("Formal-QA preparation is not eligible for exact checkout", {
          code: "formal_qa_preparation_not_eligible",
        });
      }
      const [workspace] = await tx.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces)
        .where(and(
          eq(projectWorkspaces.id, preparation.projectWorkspaceId),
          eq(projectWorkspaces.companyId, preparation.companyId),
          eq(projectWorkspaces.projectId, preparation.projectId),
        )).limit(1);
      if (!workspace?.cwd || !path.isAbsolute(workspace.cwd)) {
        throw conflict("Formal-QA preparation has no local source repository", {
          code: "formal_qa_checkout_source_unavailable",
        });
      }

      const declaredRepoRoot = path.resolve(await gitOrThrow(["rev-parse", "--show-toplevel"], workspace.cwd, "Formal-QA source repository is unavailable"));
      const repoRoot = await fs.realpath(declaredRepoRoot).catch(() => {
        throw conflict("Formal-QA source repository is unavailable", {
          code: "formal_qa_checkout_source_unavailable",
        });
      });
      await ensureDirectoryNoSymlink(repoRoot);
      const origin = canonicalRepository(await gitOrThrow(["remote", "get-url", "origin"], repoRoot, "Formal-QA source repository has no origin"));
      if (!origin || origin !== canonicalRepository(preparation.repository)) {
        throw conflict("Formal-QA source repository does not match the sealed authority", {
          code: "formal_qa_checkout_repository_mismatch",
        });
      }
      const sourceHead = await gitOrThrow(["rev-parse", "--verify", `${preparation.headSha}^{commit}`], repoRoot, "Formal-QA exact head is unavailable locally");
      const sourceTree = await gitOrThrow(["rev-parse", "--verify", `${preparation.headSha}^{tree}`], repoRoot, "Formal-QA exact tree is unavailable locally");
      if (!SHA40_RE.test(sourceHead) || sourceHead !== preparation.headSha || sourceTree !== preparation.treeSha) {
        throw conflict("Formal-QA source does not contain the sealed exact head and tree", {
          code: "formal_qa_checkout_source_mismatch",
        });
      }

      await fs.mkdir(instanceRoot, { recursive: true, mode: 0o700 });
      await ensureDirectoryNoSymlink(instanceRoot);
      const checkoutRoot = path.resolve(instanceRoot, "formal-qa-checkouts");
      await fs.mkdir(checkoutRoot, { recursive: true, mode: 0o700 });
      await ensureDirectoryNoSymlink(checkoutRoot);
      const companyRoot = path.resolve(checkoutRoot, preparation.companyId);
      if (!isPathInside(checkoutRoot, companyRoot)) throw new Error("Formal-QA checkout company path escaped its root");
      await fs.mkdir(companyRoot, { recursive: true, mode: 0o700 });
      await ensureDirectoryNoSymlink(companyRoot);
      const checkoutPath = path.resolve(companyRoot, preparation.id);
      if (!isPathInside(companyRoot, checkoutPath)) throw new Error("Formal-QA checkout path escaped its company root");

      const [existing] = await tx.select().from(formalQaCheckouts)
        .where(eq(formalQaCheckouts.preparationId, preparation.id)).limit(1);
      if (existing) {
        if (existing.repoRoot !== repoRoot || existing.checkoutPath !== checkoutPath ||
          existing.repository !== preparation.repository || existing.headSha !== preparation.headSha ||
          existing.treeSha !== preparation.treeSha || existing.checkoutSha256 !== checkoutDigest({ preparation, repoRoot, checkoutPath })) {
          throw conflict("Formal-QA checkout receipt differs from its sealed authority", {
            code: "formal_qa_checkout_receipt_mismatch",
          });
        }
        await assertExactCheckout({ repoRoot, checkoutPath, preparation });
        return { checkout: existing, replayed: true };
      }

      const kind = await pathKind(checkoutPath);
      if (kind !== "missing") {
        throw conflict("Formal-QA checkout destination already exists without an immutable receipt", {
          code: "formal_qa_checkout_destination_occupied",
        });
      }
      await gitOrThrow(["worktree", "add", "--detach", checkoutPath, preparation.headSha], repoRoot, "Formal-QA exact checkout could not be created");
      await assertExactCheckout({ repoRoot, checkoutPath, preparation });
      const [checkout] = await tx.insert(formalQaCheckouts).values({
        preparationId: preparation.id,
        companyId: preparation.companyId,
        projectId: preparation.projectId,
        projectWorkspaceId: preparation.projectWorkspaceId,
        repository: preparation.repository,
        repoRoot,
        checkoutPath,
        headSha: preparation.headSha,
        treeSha: preparation.treeSha,
        checkoutSha256: checkoutDigest({ preparation, repoRoot, checkoutPath }),
      }).returning();
      return { checkout: checkout!, replayed: false };
    }),

    inspectPreparation: loadPreparation,
  };
}
