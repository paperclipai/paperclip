export { parseCodexStdoutLine } from "./parse-stdout.js";
export { buildCodexLocalConfig } from "./build-config.js";
// The canonical check code the Test result carries when a sandbox target has no
// ready authentication. The user interface reads this stable code to decide when
// to show the login affordance. The source file has no runtime dependencies, so
// this re-export stays safe for the browser bundle.
export { ADAPTER_AUTH_MISSING_CHECK_CODE } from "../server/auth-check.js";
