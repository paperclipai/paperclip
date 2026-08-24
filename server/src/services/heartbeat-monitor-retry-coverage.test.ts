// The monitor scheduler is part of the heartbeat service contract, but its
// behavior-focused suite predates the heartbeat coverage gate's filename
// convention. Import it here so those integration scenarios participate in the
// focused heartbeat coverage run as well as the normal server test run.
import "../__tests__/issue-monitor-scheduler.test.js";
