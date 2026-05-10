import path from "node:path";
import {
  expandHomePrefix,
  resolveDefaultBackupDir as resolveSharedDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir as resolveSharedDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir as resolveSharedDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath as resolveSharedDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir as resolveSharedDefaultStorageDir,
  resolveHomeAwarePath,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot as resolveSharedPaperclipInstanceRoot,
  resolvePaperclipSpaceId,
  resolvePaperclipSpaceRoot as resolveSharedPaperclipSpaceRoot,
} from "@paperclipai/shared/space-paths";

export {
  expandHomePrefix,
  resolveHomeAwarePath,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipSpaceId,
};

export function resolvePaperclipInstanceRoot(instanceId?: string): string {
  return resolveSharedPaperclipInstanceRoot({ instanceId });
}

export function resolvePaperclipSpaceRoot(instanceId?: string): string {
  return resolveSharedPaperclipSpaceRoot({ instanceId });
}

export function resolveDefaultConfigPath(instanceId?: string): string {
  return resolvePaperclipConfigPathForInstance({ instanceId });
}

export function resolveDefaultContextPath(): string {
  return path.resolve(resolvePaperclipHomeDir(), "context.json");
}

export function resolveDefaultCliAuthPath(): string {
  return path.resolve(resolvePaperclipHomeDir(), "auth.json");
}

export function resolveDefaultEmbeddedPostgresDir(instanceId?: string): string {
  return resolveSharedDefaultEmbeddedPostgresDir({ instanceId });
}

export function resolveDefaultLogsDir(instanceId?: string): string {
  return resolveSharedDefaultLogsDir({ instanceId });
}

export function resolveDefaultSecretsKeyFilePath(instanceId?: string): string {
  return resolveSharedDefaultSecretsKeyFilePath({ instanceId });
}

export function resolveDefaultStorageDir(instanceId?: string): string {
  return resolveSharedDefaultStorageDir({ instanceId });
}

export function resolveDefaultBackupDir(instanceId?: string): string {
  return resolveSharedDefaultBackupDir({ instanceId });
}

export function describeLocalInstancePaths(instanceId?: string) {
  const resolvedInstanceId = resolvePaperclipInstanceId(instanceId);
  const instanceRoot = resolvePaperclipInstanceRoot(resolvedInstanceId);
  const activeSpaceId = resolvePaperclipSpaceId({ instanceId: resolvedInstanceId });
  const activeSpaceRoot = resolveSharedPaperclipSpaceRoot({
    instanceId: resolvedInstanceId,
    spaceId: activeSpaceId,
  });
  return {
    homeDir: resolvePaperclipHomeDir(),
    instanceId: resolvedInstanceId,
    instanceRoot,
    activeSpaceId,
    activeSpaceRoot,
    configPath: resolveDefaultConfigPath(resolvedInstanceId),
    embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(resolvedInstanceId),
    backupDir: resolveDefaultBackupDir(resolvedInstanceId),
    logDir: resolveDefaultLogsDir(resolvedInstanceId),
    secretsKeyFilePath: resolveDefaultSecretsKeyFilePath(resolvedInstanceId),
    storageDir: resolveDefaultStorageDir(resolvedInstanceId),
  };
}
