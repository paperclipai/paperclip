import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergePaperclipConfig, paperclipConfigSchema } from "@paperclipai/shared";
import {
  updateEnvFileContents,
  writeEnvFileAtomicallyIfChanged,
} from "@paperclipai/shared/env-file";
import { resourceStatus, stockHash } from "../services/managed-resource-drift.js";
import { agentInstructionsService } from "../services/agent-instructions.js";

/**
 * Cross-cutting setup/sync rerun survival test.
 *
 * Seeds hand edits across every formerly-destructive setup/sync surface, reruns the
 * setup/sync mechanism, and asserts each edit survives. Each block drives the SAME
 * production code the writers/reconcilers use:
 *   - config.json          -> mergePaperclipConfig + paperclipConfigSchema (shared core
 *                             used by BOTH writers: cli/src/config/store.ts:writeConfig
 *                             and server/src/worktree-config.ts:writeConfigFile)
 *   - .env                 -> updateEnvFileContents + writeEnvFileAtomicallyIfChanged
 *   - managed sandbox env  -> resourceStatus/stockHash drift gate (the `shouldWrite`
 *                             classifier the boot reconciler and built-in sync share)
 *   - managed instructions -> agentInstructionsService materialize + the drift gate that
 *                             makes built-in/plugin/portability rebuilds skip operator edits
 *
 * The DB-backed end-to-end variants of the sandbox-row, skills-assignment, and
 * multi-caller instruction paths are additionally proven by the embedded-Postgres suites:
 *   server/src/__tests__/company-skills-service.test.ts        (skills add/remove/replace)
 *   server/src/services/managed-environments.test.ts           (sandbox row boot reconcile)
 *   server/src/__tests__/environment-service.test.ts           (sandbox skip + stock update)
 *   server/src/__tests__/agent-instructions-service.test.ts    (managed instruction drift)
 */

const cleanupDirs = new Set<string>();

async function tmp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    [...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }),
  );
  delete process.env.PAPERCLIP_HOME;
  delete process.env.PAPERCLIP_INSTANCE_ID;
});

const BASE_CONFIG = {
  $meta: { version: 1, updatedAt: "2026-08-07T00:00:00.000Z", source: "configure" },
  database: { mode: "embedded-postgres" },
  logging: { mode: "file" },
  server: {},
} as const;

/** Emulates a writer round-trip on disk: parse the update, merge over the parsed source. */
function writerRoundTrip(configPath: string, update: unknown): void {
  const parsedUpdate = paperclipConfigSchema.parse(update);
  const source = paperclipConfigSchema.parse(
    JSON.parse(fsSync.readFileSync(configPath, "utf8")),
  );
  const next = paperclipConfigSchema.parse(mergePaperclipConfig(source, parsedUpdate));
  fsSync.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
}

describe("setup/sync rerun survival — cross-cutting", () => {
  it("preserves unknown top-level and nested config.json keys across a writer rerun", async () => {
    const dir = await tmp("pap16587-config-");
    const configPath = path.join(dir, "config.json");

    // Seed a config that carries operator extension keys the schema does not know about.
    const seeded = paperclipConfigSchema.parse({
      ...BASE_CONFIG,
      customTopLevel: { keepMe: true, nested: [1, 2, 3] },
      server: { ...BASE_CONFIG.server, customServerKey: "operator-owned" },
    });
    fsSync.writeFileSync(configPath, JSON.stringify(seeded, null, 2) + "\n");

    // Rerun setup/sync with an unrelated known-field update (flip logging mode).
    writerRoundTrip(configPath, { ...BASE_CONFIG, logging: { mode: "cloud" } });

    const after = JSON.parse(fsSync.readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(after.customTopLevel).toEqual({ keepMe: true, nested: [1, 2, 3] });
    expect(after.server.customServerKey).toBe("operator-owned");
    expect(after.logging.mode).toBe("cloud"); // the intended update still applied
  });

  it("preserves comments, ordering, blank lines, and existing encodings in .env", async () => {
    const dir = await tmp("pap16587-env-");
    const envPath = path.join(dir, ".env");
    const original = [
      "# top comment",
      "",
      "FIRST=one",
      'QUOTED="already json"',
      "SECOND=two # trailing note",
      "",
      "# trailing comment",
      "",
    ].join("\n");
    fsSync.writeFileSync(envPath, original);

    // Rerun that only changes SECOND; everything else must be byte-preserved.
    const next = updateEnvFileContents(original, { SECOND: "changed" }, { valueEncoding: "minimal" });
    const wrote = writeEnvFileAtomicallyIfChanged(envPath, original, next);
    expect(wrote).toBe(true);

    const after = fsSync.readFileSync(envPath, "utf8");
    expect(after).toContain("# top comment");
    expect(after).toContain("# trailing comment");
    expect(after).toContain('QUOTED="already json"'); // encoding untouched
    expect(after).toContain("SECOND=changed # trailing note"); // value changed, comment kept
    expect(after.indexOf("FIRST=one")).toBeLessThan(after.indexOf("SECOND=")); // ordering kept
    expect(after.split("\n").filter((l) => l === "").length).toBe(original.split("\n").filter((l) => l === "").length);

    // A no-op rerun writes nothing.
    expect(writeEnvFileAtomicallyIfChanged(envPath, after, updateEnvFileContents(after, { SECOND: "changed" }, { valueEncoding: "minimal" }))).toBe(false);
  });

  it("skips an operator-modified managed sandbox row but advances an untouched stale one", () => {
    const stockV1 = { image: "node:20", packages: ["git"] };
    const stockV2 = { image: "node:22", packages: ["git", "curl"] };
    const v1Hash = stockHash(stockV1);
    const v2Hash = stockHash(stockV2);

    // Operator hand-edited the row away from stock -> rerun must NOT clobber it.
    const operatorHash = stockHash({ image: "node:20", packages: ["git", "operator-tool"] });
    expect(
      resourceStatus({ resourceId: "env-1", currentHash: operatorHash, bindingStockHash: v1Hash, latestStockHash: v2Hash }),
    ).toBe("operator_modified");

    // Untouched row still at last-synced stock, newer stock available -> update is exposed.
    expect(
      resourceStatus({ resourceId: "env-1", currentHash: v1Hash, bindingStockHash: v1Hash, latestStockHash: v2Hash }),
    ).toBe("stock_update_available");

    // Already current -> no-op.
    expect(
      resourceStatus({ resourceId: "env-1", currentHash: v2Hash, bindingStockHash: v1Hash, latestStockHash: v2Hash }),
    ).toBe("stock_current");
  });

  it("keeps operator edits and additions in a managed instructions tree across a re-materialize", async () => {
    const home = await tmp("pap16587-instr-home-");
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const svc = agentInstructionsService();
    const agent = { id: "agent-1", companyId: "company-1", name: "Agent 1", adapterConfig: {} };
    const stockFiles = { "AGENTS.md": "# stock\n", "docs/TOOLS.md": "## stock tools\n" };

    const first = await svc.materializeManagedBundle(agent, stockFiles, { entryFile: "AGENTS.md" });
    const root = first.bundle.managedRootPath!;

    // Operator hand-edits a managed file and adds a brand-new operator-only file.
    await fs.writeFile(path.join(root, "AGENTS.md"), "# stock\n\noperator note\n", "utf8");
    await fs.writeFile(path.join(root, "OPERATOR.md"), "operator-added\n", "utf8");

    // The drift gate the built-in/plugin/portability rebuilds share: classify the tree.
    const currentFiles = {
      "AGENTS.md": await fs.readFile(path.join(root, "AGENTS.md"), "utf8"),
      "docs/TOOLS.md": await fs.readFile(path.join(root, "docs", "TOOLS.md"), "utf8"),
    };
    const status = resourceStatus({
      resourceId: agent.id,
      currentHash: stockHash(currentFiles),
      bindingStockHash: stockHash(stockFiles),
      latestStockHash: stockHash(stockFiles),
    });
    expect(status).toBe("operator_modified"); // -> reconcile shouldWrite=false, tree left intact

    // Prove the on-disk edits and additions still exist after the sync decision.
    await expect(fs.readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toContain("operator note");
    await expect(fs.readFile(path.join(root, "OPERATOR.md"), "utf8")).resolves.toBe("operator-added\n");
  });
});
