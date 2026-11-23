import { describeSshHeartbeatRuns } from "./__tests__/ssh-remote-workspace-fixture.js";

describeSshHeartbeatRuns("Cloud SSH heartbeat runs for codex_local with a real SSH server", { include: ["codex_local"] });
