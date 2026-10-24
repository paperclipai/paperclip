import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import { updateEnvFileContents, writeEnvFileAtomicallyIfChanged } from "@paperclipai/shared/env-file";
import { resolvePaperclipEnvPath } from "./paths.js";

type BootstrapResult = { source: "process_env" | "env_file" | "generated"; envFilePath: string };

function configuredSecret(env: NodeJS.ProcessEnv) {
  return env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || env.BETTER_AUTH_SECRET?.trim();
}

function readEnvFile(envFilePath: string) {
  try { return readFileSync(envFilePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function loadFileSecret(contents: string | null, env: NodeJS.ProcessEnv) {
  const entries = parse(contents ?? "");
  for (const key of ["PAPERCLIP_AGENT_JWT_SECRET", "BETTER_AUTH_SECRET"] as const) {
    if (entries[key]?.trim()) {
      env[key] = entries[key].trim();
      return true;
    }
  }
  return false;
}

function readCandidate(candidatePath: string) {
  const stats = lstatSync(candidatePath);
  if (!stats.isFile() || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    throw new Error(`Agent JWT bootstrap candidate at ${candidatePath} must be a private regular file`);
  }
  const secret = readFileSync(candidatePath, "utf8");
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error(`Invalid agent JWT bootstrap candidate at ${candidatePath}`);
  return secret;
}

function candidateSecret(candidatePath: string) {
  if (existsSync(candidatePath)) return readCandidate(candidatePath);
  const temporaryPath = `${candidatePath}.${process.pid}.${randomUUID()}.tmp`;
  const generated = randomBytes(32).toString("hex");
  writeFileSync(temporaryPath, generated, { mode: 0o600, flag: "wx" });
  try {
    try { linkSync(temporaryPath, candidatePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Publish a complete candidate exclusively. Concurrent starters and a
    // starter resuming after a crash therefore use the same generated value.
    return readCandidate(candidatePath);
  } finally { unlinkSync(temporaryPath); }
}

function removeCandidate(candidatePath: string) {
  try { unlinkSync(candidatePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Called only by local_trusted startup, after the normal env loading policy. */
export async function ensureLocalTrustedAgentJwtSecret(
  envFilePath = resolvePaperclipEnvPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapResult> {
  if (configuredSecret(env)) return { source: "process_env", envFilePath };
  const candidatePath = `${envFilePath}.agent-jwt-bootstrap`;
  try {
    if (loadFileSecret(readEnvFile(envFilePath), env)) return { source: "env_file", envFilePath };
    await mkdir(path.dirname(envFilePath), { recursive: true });
    const secret = candidateSecret(candidatePath);
    // Another initializer may have completed while this process prepared its
    // candidate. Re-read the authoritative env file before changing anything.
    const previousContents = readEnvFile(envFilePath);
    if (loadFileSecret(previousContents, env)) {
      removeCandidate(candidatePath);
      return { source: "env_file", envFilePath };
    }
    const nextContents = updateEnvFileContents(previousContents ?? "", { PAPERCLIP_AGENT_JWT_SECRET: secret });
    writeEnvFileAtomicallyIfChanged(envFilePath, previousContents, nextContents);
    removeCandidate(candidatePath);
    env.PAPERCLIP_AGENT_JWT_SECRET = secret;
    return { source: "generated", envFilePath };
  } catch (error) {
    // A successful concurrent initializer can remove its candidate between
    // our existence check and read. Its persisted env file is authoritative.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && loadFileSecret(readEnvFile(envFilePath), env)) {
      return { source: "env_file", envFilePath };
    }
    throw new Error(`Cannot initialize the agent JWT signing secret in ${envFilePath}. Check the instance directory permissions or configure PAPERCLIP_AGENT_JWT_SECRET before starting Paperclip.`, { cause: error });
  }
}
