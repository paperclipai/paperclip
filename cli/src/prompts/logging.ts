import * as p from "@clack/prompts";
import { t } from "../i18n/index.js";
import type { LoggingConfig } from "../config/schema.js";
import { resolveDefaultLogsDir, resolvePaperclipInstanceId } from "../config/home.js";

export async function promptLogging(): Promise<LoggingConfig> {
  const defaultLogDir = resolveDefaultLogsDir(resolvePaperclipInstanceId());
  const mode = await p.select({
    message: t("logging.mode_message"),
    options: [
      { value: "file" as const, label: t("logging.file_label"), hint: t("logging.file_hint") },
      { value: "cloud" as const, label: t("logging.cloud_label"), hint: t("logging.cloud_hint") },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel(t("logging.setup_cancelled"));
    process.exit(0);
  }

  if (mode === "file") {
    const logDir = await p.text({
      message: t("logging.log_dir_message"),
      defaultValue: defaultLogDir,
      placeholder: defaultLogDir,
    });

    if (p.isCancel(logDir)) {
      p.cancel(t("logging.setup_cancelled"));
      process.exit(0);
    }

    return { mode: "file", logDir: logDir || defaultLogDir };
  }

  p.note(t("logging.cloud_coming_soon"));
  return { mode: "file", logDir: defaultLogDir };
}
