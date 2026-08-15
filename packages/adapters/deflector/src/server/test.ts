import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { defaultAuditPath, defaultKbPath } from "./match.js";
import { loadPatterns, openKb, seedKbIfEmpty } from "./kb.js";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const kbPath = asString(config.kbPath, defaultKbPath());
  const auditPath = asString(config.auditPath, defaultAuditPath());

  checks.push({
    code: "deflector_kb_path",
    level: "info",
    message: `KB path: ${kbPath}`,
  });
  checks.push({
    code: "deflector_audit_path",
    level: "info",
    message: `Audit path: ${auditPath}`,
  });

  try {
    const db = openKb(kbPath);
    try {
      const seeded = seedKbIfEmpty(db);
      const patterns = loadPatterns(db);
      checks.push({
        code: "deflector_kb_readable",
        level: "info",
        message: `KB OK (${patterns.length} enabled patterns${seeded ? `, seeded ${seeded}` : ""})`,
      });
      if (patterns.length === 0) {
        checks.push({
          code: "deflector_kb_empty",
          level: "warn",
          message: "KB has zero enabled patterns; Deflector will never auto-resolve.",
        });
      }
    } finally {
      db.close();
    }
  } catch (err) {
    checks.push({
      code: "deflector_kb_error",
      level: "error",
      message: err instanceof Error ? err.message : "Failed to open KB",
      detail: kbPath,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
