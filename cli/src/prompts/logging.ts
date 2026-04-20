import * as p from "@clack/prompts";
import { defaultLoggingRotationConfig } from "@paperclipai/shared";
import type { LoggingConfig } from "../config/schema.js";
import { resolveDefaultLogsDir, resolvePaperclipInstanceId } from "../config/home.js";

export async function promptLogging(current?: LoggingConfig): Promise<LoggingConfig> {
  const defaultLogDir = resolveDefaultLogsDir(resolvePaperclipInstanceId());
  const base: LoggingConfig = current ?? {
    mode: "file",
    logDir: defaultLogDir,
    rotation: { ...defaultLoggingRotationConfig },
  };
  const mode = await p.select({
    message: "Logging mode",
    options: [
      { value: "file" as const, label: "File-based logging", hint: "recommended" },
      { value: "cloud" as const, label: "Cloud logging", hint: "coming soon" },
    ],
    initialValue: base.mode,
  });

  if (p.isCancel(mode)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (mode === "file") {
    const logDir = await p.text({
      message: "Log directory",
      defaultValue: base.logDir || defaultLogDir,
      placeholder: defaultLogDir,
    });

    if (p.isCancel(logDir)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const rotationEnabled = await p.confirm({
      message: "Rotate server logs automatically?",
      initialValue: base.rotation.enabled,
    });

    if (p.isCancel(rotationEnabled)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    let maxFileSizeMb = base.rotation.maxFileSizeMb || defaultLoggingRotationConfig.maxFileSizeMb;
    let maxFiles = base.rotation.maxFiles || defaultLoggingRotationConfig.maxFiles;

    if (rotationEnabled) {
      const maxFileSizeInput = await p.text({
        message: "Maximum active log size (MB)",
        defaultValue: String(maxFileSizeMb),
        placeholder: String(defaultLoggingRotationConfig.maxFileSizeMb),
        validate: (value) => {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 1) return "Maximum size must be a positive integer";
          if (parsed > 10_000) return "Maximum size must be 10000 MB or less";
          return undefined;
        },
      });

      if (p.isCancel(maxFileSizeInput)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      const maxFilesInput = await p.text({
        message: "How many log files should be retained?",
        defaultValue: String(maxFiles),
        placeholder: String(defaultLoggingRotationConfig.maxFiles),
        validate: (value) => {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 1) return "Retention count must be a positive integer";
          if (parsed > 1_000) return "Retention count must be 1000 files or less";
          return undefined;
        },
      });

      if (p.isCancel(maxFilesInput)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      maxFileSizeMb = Number(maxFileSizeInput || defaultLoggingRotationConfig.maxFileSizeMb);
      maxFiles = Number(maxFilesInput || defaultLoggingRotationConfig.maxFiles);
    }

    return {
      mode: "file",
      logDir: logDir || defaultLogDir,
      rotation: {
        enabled: rotationEnabled,
        maxFileSizeMb,
        maxFiles,
      },
    };
  }

  p.note("Cloud logging is coming soon. Using file-based logging for now.");
  return {
    mode: "file",
    logDir: base.logDir || defaultLogDir,
    rotation: { ...base.rotation },
  };
}
