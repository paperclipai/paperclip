import { describeSshHeartbeatRuns } from "./__tests__/ssh-remote-workspace-fixture.js";

// One suite per harness family keeps each file well under the CI per-file budget.
describeSshHeartbeatRuns("Cloud SSH heartbeat runs for claude_local with a real SSH server", { include: ["claude_local"] });
