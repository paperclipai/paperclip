import { describeSshHeartbeatRuns } from "./__tests__/ssh-remote-workspace-fixture.js";

// Every harness without its own suite runs here, so a new harness is covered by default.
describeSshHeartbeatRuns("Cloud SSH heartbeat runs for the remaining harnesses with a real SSH server",
  { exclude: ["claude_local", "codex_local", "gemini_local"] });
