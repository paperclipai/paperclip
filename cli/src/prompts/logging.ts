import * as p from "@clack/prompts";
import type { LoggingConfig } from "../config/schema.js";
import { resolveDefaultLogsDir, resolvePaperclipInstanceId } from "../config/home.js";

export async function promptLogging(): Promise<LoggingConfig> {
  const defaultLogDir = resolveDefaultLogsDir(resolvePaperclipInstanceId());
  const mode = await p.select({
    message: "日志模式",
    options: [
      { value: "file" as const, label: "基于文件的日志", hint: "推荐" },
      { value: "cloud" as const, label: "云端日志", hint: "即将推出" },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel("设置已取消。");
    process.exit(0);
  }

  if (mode === "file") {
    const logDir = await p.text({
      message: "日志目录",
      defaultValue: defaultLogDir,
      placeholder: defaultLogDir,
    });

    if (p.isCancel(logDir)) {
      p.cancel("设置已取消。");
      process.exit(0);
    }

    return { mode: "file", logDir: logDir || defaultLogDir };
  }

  p.note("云端日志即将推出。目前使用基于文件的日志。");
  return { mode: "file", logDir: defaultLogDir };
}
