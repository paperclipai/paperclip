export function buildDeflectorConfig(values: Record<string, unknown>): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  const kbPath = typeof values.kbPath === "string" ? values.kbPath.trim() : "";
  const auditPath = typeof values.auditPath === "string" ? values.auditPath.trim() : "";
  if (kbPath) ac.kbPath = kbPath;
  if (auditPath) ac.auditPath = auditPath;
  if (values.dryRun === true) ac.dryRun = true;
  return ac;
}
