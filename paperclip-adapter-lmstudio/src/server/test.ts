import { fetchModels } from "./models.js";

interface TestCheck {
  level: "info" | "warn" | "error";
  message: string;
  hint?: string;
  code: string;
}

interface TestResult {
  adapterType: string;
  status: "pass" | "warn" | "fail";
  checks: TestCheck[];
  testedAt: string;
}

interface TestContext {
  adapterType: string;
  config: Record<string, unknown>;
}

function asString(val: unknown, fallback: string): string {
  return typeof val === "string" ? val : fallback;
}

export async function testEnvironment(ctx: TestContext): Promise<TestResult> {
  const checks: TestCheck[] = [];
  const url = asString(ctx.config.url, "http://localhost:1234");
  const defaultModel = asString(ctx.config.defaultModel, "");

  const models = await fetchModels(url);
  if (models.length === 0) {
    checks.push({
      level: "error",
      message: `LM Studio nicht erreichbar unter ${url}`,
      hint: "Stelle sicher, dass LM Studio läuft und die API aktiviert ist.",
      code: "lmstudio_unreachable",
    });
    return { adapterType: ctx.adapterType, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  checks.push({
    level: "info",
    message: `LM Studio erreichbar. ${models.length} Modell(e) geladen: ${models.join(", ")}`,
    code: "lmstudio_reachable",
  });

  if (defaultModel && !models.includes(defaultModel)) {
    checks.push({
      level: "warn",
      message: `Konfiguriertes Modell "${defaultModel}" ist nicht geladen. Verfügbar: ${models.join(", ")}`,
      hint: "Lade das Modell in LM Studio oder ändere die Konfiguration.",
      code: "model_not_loaded",
    });
    return { adapterType: ctx.adapterType, status: "warn", checks, testedAt: new Date().toISOString() };
  }

  if (defaultModel) {
    checks.push({
      level: "info",
      message: `Modell "${defaultModel}" ist geladen und verfügbar.`,
      code: "model_available",
    });
  }

  return { adapterType: ctx.adapterType, status: "pass", checks, testedAt: new Date().toISOString() };
}
