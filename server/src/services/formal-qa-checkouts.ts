import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  formalQaCheckouts,
  formalQaIssuances,
  formalQaPolicies,
  formalQaPreparations,
} from "@paperclipai/db";
import { createGitRemoteAuthProvider, isGitHubHttpsRemoteUrl, type GitRemoteAuthProvider } from "./git-credentials.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { conflict, notFound } from "../errors.js";

const execFileAsync = promisify(execFile);
const TRUSTED_GIT_BINARY = "/usr/bin/git";
const GIT_TIMEOUT_MS = 30_000;
const SHA40_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

type PreparationRow = typeof formalQaPreparations.$inferSelect;
type CheckoutRow = typeof formalQaCheckouts.$inferSelect;
type IssuanceRow = typeof formalQaIssuances.$inferSelect;
type PolicyRow = typeof formalQaPolicies.$inferSelect;

type GitResult = { stdout: string; stderr: string; code: number };

function isolatedGitEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

async function runGit(args: string[], cwd: string, extraEnv?: Record<string, string>): Promise<GitResult> {
  try {
    const result = await execFileAsync(TRUSTED_GIT_BINARY, [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "protocol.file.allow=never",
      "-c", "protocol.allow=never",
      "-c", "core.attributesfile=/dev/null",
      ...args,
    ], {
      cwd,
      env: isolatedGitEnvironment(extraEnv),
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

async function gitOrThrow(args: string[], cwd: string, message: string, extraEnv?: Record<string, string>): Promise<string> {
  const result = await runGit(args, cwd, extraEnv);
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
    companyId: input.preparation.companyId,
    projectId: input.preparation.projectId,
    projectWorkspaceId: input.preparation.projectWorkspaceId,
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
export function formalQaCheckoutService(db: Db, options?: {
  instanceRoot?: string;
  /** Test seam only; production always derives the canonical GitHub HTTPS URL. */
  testOnlyRemoteUrl?: string;
  /** Test seam only for a local bare remote; production forbids file transport. */
  testOnlyAllowFileProtocol?: boolean;
  gitAuthProvider?: GitRemoteAuthProvider;
}) {
  const instanceRoot = path.resolve(options?.instanceRoot ?? resolvePaperclipInstanceRoot());
  const configuredGitAuthProvider = options?.gitAuthProvider ?? null;

  function assertLivePolicy(input: { issuance: IssuanceRow; policy: PolicyRow | undefined }) {
    const { issuance, policy } = input;
    if (!policy || !policy.enabled || issuance.policyId !== policy.id || issuance.policyVersion !== policy.version ||
      issuance.companyId !== policy.companyId || issuance.projectId !== policy.projectId ||
      issuance.projectWorkspaceId !== policy.projectWorkspaceId || issuance.repository !== policy.repository.toLowerCase() ||
      issuance.requiredCheckName !== policy.requiredCheckName || issuance.requiredCheckAppId !== policy.requiredCheckAppId ||
      issuance.workflowId !== policy.requiredWorkflowId) {
      throw conflict("Formal-QA policy no longer authorizes this checkout", {
        code: "formal_qa_checkout_policy_revoked",
      });
    }
  }

  function assertPreparationStatus(preparation: PreparationRow, canReconcile: boolean) {
    if (preparation.status !== "issued" || (!canReconcile && preparation.expiresAt.getTime() <= Date.now())) {
      throw conflict("Formal-QA preparation is not eligible for exact checkout", {
        code: "formal_qa_preparation_not_eligible",
      });
    }
  }

  async function resolvePlan(preparation: PreparationRow) {
    await fs.mkdir(instanceRoot, { recursive: true, mode: 0o700 });
    await ensureDirectoryNoSymlink(instanceRoot);
    const mirrorsRoot = path.resolve(instanceRoot, "formal-qa-mirrors");
    await fs.mkdir(mirrorsRoot, { recursive: true, mode: 0o700 });
    await ensureDirectoryNoSymlink(mirrorsRoot);
    const mirrorName = createHash("sha256").update(preparation.repository).digest("hex");
    const repoRoot = path.resolve(mirrorsRoot, mirrorName);
    if (!isPathInside(mirrorsRoot, repoRoot)) throw new Error("Formal-QA mirror path escaped its root");
    const checkoutRoot = path.resolve(instanceRoot, "formal-qa-checkouts");
    await fs.mkdir(checkoutRoot, { recursive: true, mode: 0o700 });
    await ensureDirectoryNoSymlink(checkoutRoot);
    const companyRoot = path.resolve(checkoutRoot, preparation.companyId);
    if (!isPathInside(checkoutRoot, companyRoot)) throw new Error("Formal-QA checkout company path escaped its root");
    await fs.mkdir(companyRoot, { recursive: true, mode: 0o700 });
    await ensureDirectoryNoSymlink(companyRoot);
    const checkoutPath = path.resolve(companyRoot, preparation.id);
    if (!isPathInside(companyRoot, checkoutPath)) throw new Error("Formal-QA checkout path escaped its company root");
    return { repoRoot, checkoutPath };
  }

  function remoteUrlFor(preparation: PreparationRow): string {
    if (options?.testOnlyRemoteUrl) return options.testOnlyRemoteUrl;
    const repository = canonicalRepository(preparation.repository);
    if (!repository) {
      throw conflict("Formal-QA authority has an invalid repository", {
        code: "formal_qa_checkout_repository_mismatch",
      });
    }
    return `https://github.com/${repository}.git`;
  }

  async function materializeMirror(preparation: PreparationRow, plan: { repoRoot: string; checkoutPath: string }) {
    const parent = path.dirname(plan.repoRoot);
    await ensureDirectoryNoSymlink(parent);
    const kind = await pathKind(plan.repoRoot);
    if (kind === "missing") {
      await gitOrThrow(["init", "--bare", plan.repoRoot], parent, "Formal-QA clean mirror could not be initialized");
    } else if (kind !== "directory") {
      throw conflict("Formal-QA mirror path is not a trusted directory", { code: "formal_qa_checkout_path_untrusted" });
    }
    await ensureDirectoryNoSymlink(plan.repoRoot);
    if (await gitOrThrow(["rev-parse", "--is-bare-repository"], plan.repoRoot, "Formal-QA mirror is invalid") !== "true") {
      throw conflict("Formal-QA mirror is not bare", { code: "formal_qa_checkout_verification_failed" });
    }
    const remoteUrl = remoteUrlFor(preparation);
    const existing = await runGit(["remote", "get-url", "origin"], plan.repoRoot);
    if (existing.code !== 0) {
      await gitOrThrow(["remote", "add", "origin", remoteUrl], plan.repoRoot, "Formal-QA mirror remote could not be configured");
    } else if (existing.stdout !== remoteUrl) {
      throw conflict("Formal-QA clean mirror remote differs from its sealed authority", {
        code: "formal_qa_checkout_repository_mismatch",
      });
    }
    const authProvider = configuredGitAuthProvider ?? createGitRemoteAuthProvider(db, preparation.companyId, {
      responsibleUserId: preparation.issuedByUserId,
    });
    const auth = isGitHubHttpsRemoteUrl(remoteUrl)
      ? await authProvider(remoteUrl)
      : null;
    if (isGitHubHttpsRemoteUrl(remoteUrl) && !auth) {
      throw conflict("No scoped GitHub credential is available for Formal-QA checkout", {
        code: "formal_qa_checkout_credential_unavailable",
      });
    }
    await gitOrThrow([
      ...(auth?.configArgs ?? []),
      ...(options?.testOnlyAllowFileProtocol ? ["-c", "protocol.file.allow=always"] : []),
      "fetch", "--no-tags", "--no-write-fetch-head", "origin", preparation.headSha,
    ], plan.repoRoot, "Formal-QA exact head could not be fetched from the clean mirror", auth?.env);
    const head = await gitOrThrow(["rev-parse", "--verify", `${preparation.headSha}^{commit}`], plan.repoRoot, "Formal-QA exact head is unavailable from the clean mirror");
    const tree = await gitOrThrow(["rev-parse", "--verify", `${preparation.headSha}^{tree}`], plan.repoRoot, "Formal-QA exact tree is unavailable from the clean mirror");
    if (!SHA40_RE.test(head) || head !== preparation.headSha || tree !== preparation.treeSha) {
      throw conflict("Formal-QA clean mirror does not contain the sealed exact head and tree", {
        code: "formal_qa_checkout_source_mismatch",
      });
    }
  }

  function assertReceipt(input: {
    checkout: CheckoutRow;
    preparation: PreparationRow;
    plan: { repoRoot: string; checkoutPath: string };
  }) {
    const { checkout, preparation, plan } = input;
    if (checkout.status !== "creating" && checkout.status !== "verified") {
      throw conflict("Formal-QA checkout receipt has an invalid state", {
        code: "formal_qa_checkout_receipt_mismatch",
      });
    }
    if (checkout.companyId !== preparation.companyId || checkout.projectId !== preparation.projectId ||
      checkout.projectWorkspaceId !== preparation.projectWorkspaceId || checkout.repoRoot !== plan.repoRoot ||
      checkout.checkoutPath !== plan.checkoutPath || checkout.repository !== preparation.repository ||
      checkout.headSha !== preparation.headSha || checkout.treeSha !== preparation.treeSha ||
      checkout.checkoutSha256 !== checkoutDigest({ preparation, repoRoot: plan.repoRoot, checkoutPath: plan.checkoutPath })) {
      throw conflict("Formal-QA checkout receipt differs from its sealed authority", {
        code: "formal_qa_checkout_receipt_mismatch",
      });
    }
  }

  return {
    getByPreparationId: async (preparationId: string): Promise<CheckoutRow | null> => {
      const [checkout] = await db.select().from(formalQaCheckouts)
        .where(eq(formalQaCheckouts.preparationId, preparationId)).limit(1);
      return checkout ?? null;
    },

    /**
     * Closed dispatch boundary for the scheduler. The caller supplies only the
     * durable preparation id; every path and digest is reloaded from the
     * server-owned records and reverified immediately before execution.
     */
    verifyForDispatch: async ({ preparationId }: { preparationId: string }) => {
      const verified = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_dispatch:${preparationId}`}, 0))`);
        const [preparation] = await tx.select().from(formalQaPreparations)
          .where(eq(formalQaPreparations.id, preparationId)).for("update").limit(1);
        if (!preparation || preparation.status !== "issued" || preparation.expiresAt.getTime() <= Date.now()) {
          throw conflict("Formal-QA preparation is not eligible for dispatch", {
            code: "formal_qa_dispatch_not_eligible",
          });
        }
        const [issuance] = await tx.select().from(formalQaIssuances)
          .where(eq(formalQaIssuances.preparationId, preparation.id)).limit(1);
        const [checkout] = await tx.select().from(formalQaCheckouts)
          .where(eq(formalQaCheckouts.preparationId, preparation.id)).limit(1);
        if (!issuance?.policyId || !issuance.evidenceJson || !checkout || checkout.status !== "verified" ||
          createHash("sha256").update(issuance.evidenceJson).digest("hex") !== issuance.snapshotSha256) {
          throw conflict("Formal-QA dispatch lacks verified immutable evidence", {
            code: "formal_qa_dispatch_evidence_missing",
          });
        }
        const [policy] = await tx.select().from(formalQaPolicies)
          .where(eq(formalQaPolicies.id, issuance.policyId)).limit(1);
        assertLivePolicy({ issuance, policy });
        const plan = await resolvePlan(preparation);
        assertReceipt({ checkout, preparation, plan });
        return { preparation, issuance, checkout, policy: policy!, plan };
      });
      await assertExactCheckout({ ...verified.plan, preparation: verified.preparation });
      return {
        preparation: verified.preparation,
        issuance: verified.issuance,
        checkout: verified.checkout,
        policy: verified.policy,
      };
    },

    materialize: async ({ preparationId }: { preparationId: string }) => {
      // First commit a durable, deterministic destination before an external
      // Git operation. A process death after `worktree add` then leaves a
      // recoverable `creating` receipt rather than an orphan that blocks every
      // future attempt.
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_checkout:${preparationId}`}, 0))`);
        const [preparation] = await tx.select().from(formalQaPreparations)
          .where(eq(formalQaPreparations.id, preparationId)).limit(1);
        if (!preparation) throw notFound("Formal-QA preparation not found");
        if (preparation.status !== "issued") {
          throw conflict("Formal-QA checkout requires a trusted issued preparation", {
            code: "formal_qa_checkout_issuance_missing",
          });
        }
        const [existing] = await tx.select().from(formalQaCheckouts)
          .where(eq(formalQaCheckouts.preparationId, preparation.id)).limit(1);
        const [issuance] = await tx.select().from(formalQaIssuances)
          .where(eq(formalQaIssuances.preparationId, preparation.id)).limit(1);
        if (!issuance || !issuance.policyId || !issuance.policyVersion || !issuance.requiredCheckAppId ||
          !issuance.checkSuiteId || !issuance.workflowRunId || !issuance.workflowId || !issuance.evidenceJson ||
          createHash("sha256").update(issuance.evidenceJson).digest("hex") !== issuance.snapshotSha256 ||
          issuance.companyId !== preparation.companyId || issuance.projectId !== preparation.projectId ||
          issuance.projectWorkspaceId !== preparation.projectWorkspaceId || issuance.repository !== preparation.repository ||
          issuance.prNumber !== String(preparation.prNumber) || issuance.headSha !== preparation.headSha ||
          issuance.baseRef !== preparation.baseRef || issuance.baseSha !== preparation.baseSha || issuance.treeSha !== preparation.treeSha) {
          throw conflict("Formal-QA checkout has no matching trusted GitHub issuance", {
            code: "formal_qa_checkout_issuance_missing",
          });
        }
        const [policy] = await tx.select().from(formalQaPolicies)
          .where(eq(formalQaPolicies.id, issuance.policyId!)).limit(1);
        assertLivePolicy({ issuance, policy });
        assertPreparationStatus(preparation, Boolean(existing));
        const plan = await resolvePlan(preparation);
        if (existing) {
          assertReceipt({ checkout: existing, preparation, plan });
          return;
        }
        if (await pathKind(plan.checkoutPath) !== "missing") {
          throw conflict("Formal-QA checkout destination already exists without an immutable receipt", {
            code: "formal_qa_checkout_destination_occupied",
          });
        }
        await tx.insert(formalQaCheckouts).values({
          preparationId: preparation.id,
          companyId: preparation.companyId,
          projectId: preparation.projectId,
          projectWorkspaceId: preparation.projectWorkspaceId,
          repository: preparation.repository,
          repoRoot: plan.repoRoot,
          checkoutPath: plan.checkoutPath,
          headSha: preparation.headSha,
          treeSha: preparation.treeSha,
          checkoutSha256: checkoutDigest({ preparation, ...plan }),
          status: "creating",
        });
      });

      // Do not hold a database transaction (or its advisory lock) across a
      // network fetch. The durable `creating` receipt above is the recovery
      // point: concurrent callers can both attempt idempotent filesystem work,
      // but only a receipt that still matches the sealed preparation may become
      // verified below. This avoids turning a transient GitHub outage into a
      // long-running database lock that blocks unrelated Formal-QA requests.
      const materialization = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_checkout:${preparationId}`}, 0))`);
        const [preparation] = await tx.select().from(formalQaPreparations)
          .where(eq(formalQaPreparations.id, preparationId)).for("update").limit(1);
        if (!preparation) throw notFound("Formal-QA preparation not found");
        if (preparation.status !== "issued") {
          throw conflict("Formal-QA checkout requires a trusted issued preparation", {
            code: "formal_qa_checkout_issuance_missing",
          });
        }
        const [checkout] = await tx.select().from(formalQaCheckouts)
          .where(eq(formalQaCheckouts.preparationId, preparation.id)).for("update").limit(1);
        if (!checkout) throw new Error("Formal-QA checkout receipt disappeared during materialization");
        const [issuance] = await tx.select().from(formalQaIssuances)
          .where(eq(formalQaIssuances.preparationId, preparation.id)).limit(1);
        if (!issuance || !issuance.policyId || !issuance.policyVersion || !issuance.requiredCheckAppId ||
          !issuance.checkSuiteId || !issuance.workflowRunId || !issuance.workflowId || !issuance.evidenceJson ||
          createHash("sha256").update(issuance.evidenceJson).digest("hex") !== issuance.snapshotSha256 ||
          issuance.companyId !== preparation.companyId || issuance.projectId !== preparation.projectId ||
          issuance.projectWorkspaceId !== preparation.projectWorkspaceId || issuance.repository !== preparation.repository ||
          issuance.prNumber !== String(preparation.prNumber) || issuance.headSha !== preparation.headSha ||
          issuance.baseRef !== preparation.baseRef || issuance.baseSha !== preparation.baseSha || issuance.treeSha !== preparation.treeSha) {
          throw conflict("Formal-QA checkout has no matching trusted GitHub issuance", {
            code: "formal_qa_checkout_issuance_missing",
          });
        }
        const [policy] = await tx.select().from(formalQaPolicies)
          .where(eq(formalQaPolicies.id, issuance.policyId!)).limit(1);
        assertLivePolicy({ issuance, policy });
        assertPreparationStatus(preparation, true);
        const plan = await resolvePlan(preparation);
        assertReceipt({ checkout, preparation, plan });
        if (checkout.status === "verified") {
          return { checkout, preparation, plan, replayed: true };
        }
        return { checkout, preparation, plan, replayed: false };
      });

      if (materialization.replayed) {
        await assertExactCheckout({
          ...materialization.plan,
          preparation: materialization.preparation,
        });
        return { checkout: materialization.checkout, replayed: true };
      }

      await materializeMirror(
        materialization.preparation,
        materialization.plan,
      );
      const kind = await pathKind(materialization.plan.checkoutPath);
      if (kind === "missing") {
        await gitOrThrow(
          [
            "worktree",
            "add",
            "--detach",
            materialization.plan.checkoutPath,
            materialization.preparation.headSha,
          ],
          materialization.plan.repoRoot,
          "Formal-QA exact checkout could not be created",
        );
      } else if (kind !== "directory") {
        throw conflict("Formal-QA checkout destination is not a trusted directory", {
          code: "formal_qa_checkout_destination_occupied",
        });
      }
      await assertExactCheckout({
        ...materialization.plan,
        preparation: materialization.preparation,
      });

      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_checkout:${preparationId}`}, 0))`);
        const [preparation] = await tx.select().from(formalQaPreparations)
          .where(eq(formalQaPreparations.id, preparationId)).for("update").limit(1);
        if (!preparation) throw notFound("Formal-QA preparation not found");
        const [checkout] = await tx.select().from(formalQaCheckouts)
          .where(eq(formalQaCheckouts.preparationId, preparationId)).for("update").limit(1);
        if (!checkout) throw new Error("Formal-QA checkout receipt disappeared during materialization");
        const [issuance] = await tx.select().from(formalQaIssuances)
          .where(eq(formalQaIssuances.preparationId, preparation.id)).limit(1);
        if (!issuance?.policyId) {
          throw conflict("Formal-QA checkout has no matching trusted GitHub issuance", {
            code: "formal_qa_checkout_issuance_missing",
          });
        }
        const [policy] = await tx.select().from(formalQaPolicies)
          .where(eq(formalQaPolicies.id, issuance.policyId)).limit(1);
        assertLivePolicy({ issuance, policy });
        const plan = await resolvePlan(preparation);
        assertPreparationStatus(preparation, true);
        assertReceipt({ checkout, preparation, plan });
        // This is local, bounded verification only. It is deliberately repeated
        // after reclaiming the receipt lock so no caller can publish a stale
        // verification after a concurrent recovery altered the checkout.
        await assertExactCheckout({ ...plan, preparation });
        if (checkout.status === "verified") {
          return { checkout, replayed: true };
        }
        const [verified] = await tx.update(formalQaCheckouts)
          .set({ status: "verified" })
          .where(and(eq(formalQaCheckouts.id, checkout.id), eq(formalQaCheckouts.status, "creating")))
          .returning();
        if (!verified) throw new Error("Formal-QA checkout receipt changed during materialization");
        return { checkout: verified, replayed: false };
      });
    },
  };
}
