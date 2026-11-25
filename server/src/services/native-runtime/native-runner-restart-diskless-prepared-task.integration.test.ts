// Isolated embedded Postgres per file so the direct and prepared-task 60s
// real-clock lease-expiry restart cases run in parallel across Vitest workers
// instead of bounding the native-server lane at ~191s serially.
import { registerNativeRunnerRestartDisklessSuite } from "../../__tests__/helpers/native-runner-restart-diskless.js";

registerNativeRunnerRestartDisklessSuite(true);
