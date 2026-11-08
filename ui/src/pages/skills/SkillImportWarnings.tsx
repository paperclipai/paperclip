import { t as translateAgentPage, useTranslation } from "@/i18n";
import { AlertTriangle } from 'lucide-react';
import type { SkillRepositoryPackage, SkillSourceCandidate } from '@paperclipai/shared';

export function skillImportWarnings(candidates: Pick<SkillSourceCandidate, 'path' | 'error' | 'inspection'>[], repositoryPackage?: SkillRepositoryPackage | null, warnings: string[] = []) {
  return [...new Set([
    ...warnings,
    ...(repositoryPackage?.warnings ?? []),
    ...(repositoryPackage?.error ? [repositoryPackage.error] : []),
    ...candidates.flatMap(candidate => [
      ...(candidate.error ? [translateAgentPage("agents:needs_setup_f2b3cf", { value1: candidate.path, value2: candidate.error })] : []),
      ...(candidate.inspection?.warnings.filter(warning => warning.includes('not included') || warning.includes('couldn’t be included')) ?? []),
      ...(candidate.inspection?.references.map(reference => `${reference.resolvedPath} — Not included; referenced by ${candidate.path}.`) ?? []),
    ]),
  ])];
}

/** Import warnings disclose omissions without creating another decision. */
export function SkillImportWarnings({ warnings }: { warnings: string[] }) {
  const { t: translateAgentPage } = useTranslation("agents");
  if (!warnings.length) return null;
  return <details className="text-sm" aria-label={translateAgentPage("agents:import_warnings")}>
    <summary className="cursor-pointer text-muted-foreground"><span className="inline-flex items-center gap-2"><AlertTriangle className="size-4 shrink-0" />{warnings.length}{" "}{translateAgentPage("agents:import_62fdfb")}{" "}{warnings.length === 1 ? translateAgentPage("agents:warning_383fd7") : translateAgentPage("agents:warnings_bd207f")}</span></summary>
    <ul className="mt-2 space-y-2 text-xs text-muted-foreground">{warnings.map(warning => <li className="break-words" key={warning}>{warning}</li>)}</ul>
  </details>;
}
