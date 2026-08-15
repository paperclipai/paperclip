import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildDeflectorConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  const kbPath = String((v as Record<string, unknown>).kbPath ?? "").trim();
  const auditPath = String((v as Record<string, unknown>).auditPath ?? "").trim();
  if (kbPath) ac.kbPath = kbPath;
  if (auditPath) ac.auditPath = auditPath;
  return ac;
}
