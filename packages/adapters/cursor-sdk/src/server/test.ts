import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { resolveRuntimeKind } from "../runtime.js";
import { loadCursorSdk } from "../sdk-types.js";

function summarize(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const runtime = resolveRuntimeKind(config.runtime);
  const envConfig = parseObject(config.env);
  const apiKey =
    (typeof envConfig.CURSOR_API_KEY === "string" ? envConfig.CURSOR_API_KEY : "") ||
    (typeof process.env.CURSOR_API_KEY === "string" ? process.env.CURSOR_API_KEY : "");

  checks.push({
    code: "cursor_sdk_runtime",
    level: "info",
    message: `Resolved runtime: ${runtime}`,
  });

  const sdk = await loadCursorSdk();
  if (!sdk) {
    checks.push({
      code: "cursor_sdk_package_missing",
      level: "error",
      message: "@cursor/sdk is not installed in the Paperclip server's node_modules.",
      hint: "Run `pnpm add @cursor/sdk` and restart the server.",
    });
  } else {
    checks.push({
      code: "cursor_sdk_package_present",
      level: "info",
      message: "@cursor/sdk loaded successfully.",
    });
  }

  if (!apiKey.trim()) {
    checks.push({
      code: "cursor_sdk_api_key_missing",
      level: "error",
      message: "CURSOR_API_KEY is not set.",
      hint: "Add it to adapter env (preferably as a secret_ref) or to the server environment.",
    });
  } else {
    checks.push({
      code: "cursor_sdk_api_key_present",
      level: "info",
      message: "CURSOR_API_KEY is set.",
      detail: `Key length: ${apiKey.trim().length} chars`,
    });
  }

  if (sdk && apiKey.trim() && sdk.Cursor?.me) {
    try {
      const me = await sdk.Cursor.me({ apiKey: apiKey.trim() });
      checks.push({
        code: "cursor_sdk_auth_ok",
        level: "info",
        message: "Cursor.me() succeeded.",
        detail: me?.userEmail ?? me?.apiKeyName ?? "API key validated",
      });
    } catch (err) {
      checks.push({
        code: "cursor_sdk_auth_failed",
        level: "error",
        message: "Cursor.me() failed; the API key may be invalid.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (runtime === "local") {
    const cwd = asString(config.cwd, "").trim();
    if (!cwd) {
      checks.push({
        code: "cursor_sdk_local_cwd_unset",
        level: "info",
        message: "config.cwd is not set; the workspace cwd from Paperclip context will be used at run time.",
      });
    } else {
      checks.push({
        code: "cursor_sdk_local_cwd_set",
        level: "info",
        message: `config.cwd: ${cwd}`,
      });
    }
  } else {
    const repository = asString(config.repository, "").trim();
    if (!repository) {
      checks.push({
        code: "cursor_sdk_cloud_repo_unset",
        level: "warn",
        message: `runtime=${runtime} requires a repository URL; will fall back to workspace.repoUrl at run time.`,
      });
    } else {
      checks.push({
        code: "cursor_sdk_cloud_repo_set",
        level: "info",
        message: `repository: ${repository}`,
        detail: `ref: ${asString(config.ref, "main")}`,
      });
    }

    const vmEnv = parseObject(config.vmEnv);
    const vmType = asString(vmEnv.type, runtime === "self_hosted" ? "pool" : "cloud").trim();
    const vmName = asString(vmEnv.name, "").trim();
    if (vmType !== "cloud" && !vmName) {
      checks.push({
        code: "cursor_sdk_vm_env_name_required",
        level: "error",
        message: `vmEnv.name is required when vmEnv.type="${vmType}".`,
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarize(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
