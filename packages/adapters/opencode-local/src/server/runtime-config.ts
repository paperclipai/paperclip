import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// OpenCode reads either `opencode.json` or `opencode.jsonc`. The latter is the
// default format the CLI writes. `opencode.json` takes precedence when both are
// present, so we prefer it here and fall back to the `.jsonc` variant.
const RUNTIME_CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;

// Strip `//` and `/* */` comments from a JSONC document so it can be parsed with
// the built-in JSON parser. String literals are tracked so comment-like
// sequences inside values are preserved.
function stripJsonComments(input: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    result += char;
  }

  return result;
}

// Remove trailing commas before `}`/`]`. VS Code-style JSONC (which OpenCode's
// config parser follows) accepts them, but the built-in JSON parser rejects
// them. Run after comment stripping so only whitespace can sit between a comma
// and the closing bracket. String literals are tracked so commas inside values
// are left intact.
function stripTrailingCommas(input: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) {
        j += 1;
      }
      if (input[j] === "}" || input[j] === "]") {
        continue;
      }
    }
    result += char;
  }

  return result;
}

// Parse a JSON/JSONC document, tolerating comments and trailing commas.
function parseJsonc(raw: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
}

// Locate the existing OpenCode config inside `configDir`, returning the parsed
// object alongside the filename it came from so the merged runtime config is
// written back to the same file (and never shadows a user's `.jsonc` with a
// fresh `.json`). Falls back to an empty object on a missing or malformed file.
async function readRuntimeConfig(
  configDir: string,
): Promise<{ config: Record<string, unknown>; filename: string }> {
  for (const filename of RUNTIME_CONFIG_FILENAMES) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(configDir, filename), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        continue;
      }
      throw err;
    }
    try {
      const parsed = parseJsonc(raw);
      return { config: isPlainObject(parsed) ? parsed : {}, filename };
    } catch {
      // Malformed config — preserve the original behaviour of still injecting
      // the permission override rather than aborting the run.
      return { config: {}, filename };
    }
  }
  return { config: {}, filename: RUNTIME_CONFIG_FILENAMES[0] };
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  // Merge into the existing config file (`opencode.json` or `opencode.jsonc`),
  // writing back to whichever the user actually has so fields like `plugin` and
  // `mcp` are preserved instead of being shadowed by a permission-only file.
  const { config: existingConfig, filename: runtimeConfigFilename } =
    await readRuntimeConfig(runtimeConfigDir);
  const runtimeConfigPath = path.join(runtimeConfigDir, runtimeConfigFilename);
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const nextConfig = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes: [
      "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
    ],
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
