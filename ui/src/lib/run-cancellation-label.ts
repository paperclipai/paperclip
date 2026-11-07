import { t } from "@/i18n";
export function runCancellationLabel(input: { grokWork?: boolean; isFailed: boolean; isPending: boolean }): string {
  if (input.grokWork) return input.isPending ? t("display:copy_008a56ae7ab8") : t("display:copy_9b72f74a7d8f");
  if (input.isFailed) return input.isPending ? t("display:copy_4cbcf99e4cca") : t("display:copy_104c6e3b389d");
  return input.isPending ? t("display:copy_1392f3493460") : t("display:copy_2ef417917132");
}
