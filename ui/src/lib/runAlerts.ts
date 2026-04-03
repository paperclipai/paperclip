import type { HeartbeatRun } from "@paperclipai/shared";

export function formatRunAlert(run: HeartbeatRun): { message: string; tone: "info" | "error" } | null {
  if (run.errorCode === "process_detached") {
    return {
      tone: "info",
      message:
        "Paperclip lost its in-memory handle for this process, but the child process is still running. Live activity will clear this warning automatically, and Cancel will still stop the process.",
    };
  }

  if (run.error) {
    return {
      tone: "error",
      message: run.error,
    };
  }

  return null;
}
