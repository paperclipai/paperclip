import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const LOCAL_PI_CONFIGURATION_ENV = "PAPERCLIP_RUNNER_LOCAL_PI";

export interface LocalPiConfiguration {
  executable: string;
  environment: Partial<Record<"HOME" | "PATH" | "PI_CODING_AGENT_DIR" | "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_CACHE_HOME", string>>;
  identity: string;
}

const homeKeys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

/** The controller supplies host paths, never the task or its environment. */
export async function resolveLocalPiConfiguration(raw: string | undefined): Promise<LocalPiConfiguration | undefined> {
  if (raw === undefined) return undefined;
  const invalid = () => new Error("Invalid operator configuration for the local Pi Runner");
  if (raw.length > 8192) throw invalid();

  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const binding = value as Record<string, unknown>;
  const { companyId, agentId, home, path, profile } = binding;
  const guid = (id: unknown) => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
  const absolute = (entry: unknown): entry is string => typeof entry === "string" && isAbsolute(entry) && !/[\u0000-\u001f\u007f]/.test(entry);
  if (!guid(companyId) || !guid(agentId) || !absolute(home) || (profile !== undefined && !absolute(profile))
    || typeof path !== "string" || /[\u0000-\u001f\u007f]/.test(path)) throw invalid();

  const canonicalHome = await realpath(home);
  if (!(await stat(canonicalHome)).isDirectory()) throw invalid();
  const agentDirectory = await realpath(profile ?? join(canonicalHome, ".pi", "agent"));
  if (!(await stat(agentDirectory)).isDirectory()) throw invalid();
  // Ignore relative and empty PATH entries, which could resolve via a task cwd.
  const directories = path.split(delimiter).filter(absolute);
  const environment: LocalPiConfiguration["environment"] = {
    HOME: canonicalHome,
    PATH: directories.join(delimiter),
    PI_CODING_AGENT_DIR: agentDirectory,
  };
  for (const key of homeKeys) {
    const entry = binding[key];
    if (entry === undefined) continue;
    if (!absolute(entry)) throw invalid();
    environment[key] = resolve(entry);
  }

  for (const directory of directories) {
    const candidate = join(directory, "pi");
    try {
      const executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      const identity = createHash("sha256").update(JSON.stringify({ executable, agentDirectory })).digest("hex");
      return { executable, environment, identity: `sha256:${identity}` };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("Local Pi executable was not found on the Paperclip server's PATH");
}
