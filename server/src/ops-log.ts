import { logger } from "./middleware/logger.js";

type OpsFields = Record<string, unknown>;

function compactOpsFields(fields?: OpsFields) {
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

function buildOpsRecord(event: string, fields?: OpsFields) {
  return {
    opsEvent: true,
    event,
    ...compactOpsFields(fields),
  };
}

export function logOpsInfo(event: string, fields?: OpsFields) {
  logger.info(buildOpsRecord(event, fields), event);
}

export function logOpsWarn(event: string, fields?: OpsFields) {
  logger.warn(buildOpsRecord(event, fields), event);
}

