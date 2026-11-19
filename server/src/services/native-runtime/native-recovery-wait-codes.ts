// Dependency-free failure codes shared by native recovery modules. Keep this a
// leaf: checkpoint readers import it, and those readers are also loaded by
// standalone tools that must not pull in the heartbeat service graph.
export const NATIVE_RETAINED_OWNER_WAIT = "native_controller_recovery_waiting_for_owner";
export const NATIVE_AGENT_DIRECTORY_BUSY_WAIT = "agent_directory_operation_busy";
