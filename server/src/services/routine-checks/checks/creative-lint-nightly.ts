import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckCtx, CheckDef, CheckResult } from "../types.js";

const execFileP = promisify(execFile);

interface ProjectResult {
  slug: string;
  exit: number;
  errors: number;
  warnings: number;
}

function getCreativeRoot(): string {
  return process.env.PAPERCLIP_CREATIVE_ROOT
    ?? join(homedir(), ".openclaw/workspace/projects/happygang");
}

function getLintScript(): string {
  return process.env.PAPERCLIP_CREATIVE_LINT
    ?? join(homedir(), ".openclaw/workspace/scripts/creative-workspace/lint.mjs");
}

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const root = getCreativeRoot();
  const lintScript = getLintScript();

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "error",
      findings: 0,
      payload: { error: `cannot read creative root ${root}: ${msg}` },
      summary: `creative-lint-nightly: root unreadable`,
    };
  }

  const projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const results: ProjectResult[] = [];

  for (const slug of projects) {
    const projectDir = join(root, slug);
    let exit = 0;
    let errors = 0;
    let warnings = 0;
    try {
      const { stdout } = await execFileP("node", [lintScript, "--json", projectDir], { timeout: 30_000 });
      const parsed = JSON.parse(stdout) as { errors?: number; warnings?: number };
      errors = Number(parsed.errors ?? 0);
      warnings = Number(parsed.warnings ?? 0);
    } catch (e) {
      const err = e as { code?: number; stdout?: string; message?: string };
      exit = typeof err.code === "number" ? err.code : 1;
      if (err.stdout) {
        try {
          const parsed = JSON.parse(err.stdout) as { errors?: number; warnings?: number };
          errors = Number(parsed.errors ?? 0);
          warnings = Number(parsed.warnings ?? 0);
        } catch {
          ctx.logger.warn({ slug, stderr: err.message }, "creative-lint-nightly: failed to parse JSON output");
        }
      } else {
        ctx.logger.warn({ slug, err: err.message }, "creative-lint-nightly: lint invocation failed");
      }
    }
    results.push({ slug, exit, errors, warnings });
  }

  const totalErrors = results.reduce((s, r) => s + r.errors, 0);
  const totalWarnings = results.reduce((s, r) => s + r.warnings, 0);
  const status: CheckResult["status"] = totalErrors > 0 ? "warn" : "ok";

  return {
    status,
    findings: totalErrors,
    payload: { projects: results, totals: { errors: totalErrors, warnings: totalWarnings } },
    summary: totalErrors > 0
      ? `creative-lint: ${results.length} projects, ${totalErrors} errors, ${totalWarnings} warnings`
      : `creative-lint: ${results.length} projects clean (${totalWarnings} warnings)`,
  };
}

export const creativeLintNightly: CheckDef = {
  name: "creative-lint-nightly",
  schedule: "30 2 * * *",
  notify: "silent",
  run,
};
