import { randomUUID } from "node:crypto";
import os from "node:os";

/**
 * Identity of THIS server process for distributed coordination. Scheduler
 * leadership (`scheduler_leader.leader_id`) and run-executor claims
 * (`heartbeat_runs.claimed_by`) use the SAME string so operators can
 * correlate lease rows with claims, and so the orphaned-run reaper can tell
 * its own claims from foreign ones. Unique per process (UUID minted at
 * module load), stable for the process lifetime.
 */
export const PROCESS_REPLICA_ID = `${os.hostname()}-${process.pid}-${randomUUID()}`;
