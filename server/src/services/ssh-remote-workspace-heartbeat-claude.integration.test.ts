import { describeSshHeartbeatRuns } from "./__tests__/ssh-remote-workspace-fixture.js";

describeSshHeartbeatRuns("Cloud SSH heartbeat runs for claude_local with a real SSH server", { include: ["claude_local"] });
