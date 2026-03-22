import type { DevServerHealthStatus } from "../api/health";

export function DevRestartBanner(_props: { devServer?: DevServerHealthStatus }) {
  // Banner is permanently disabled — PM2/cron handles scheduled restarts
  return null;
}
