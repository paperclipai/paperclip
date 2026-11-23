import { describeSshHeartbeatRuns } from "./__tests__/ssh-remote-workspace-fixture.js";

describeSshHeartbeatRuns("Cloud SSH heartbeat runs for the remaining harnesses with a real SSH server",
  { exclude: ["claude_local", "codex_local", "gemini_local"] });
