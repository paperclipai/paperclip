import type { Db } from "@paperclipai/db";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { dotRunnerBroker } from "../dot-runner-broker.js";
import { museRunnerBroker } from "../muse-runner-broker.js";

/** Shared fresh-run authority for native tools and authenticated REST mutations. */
export async function assertExternalNativeRunAuthority(db: Db, execution: NativeExecutionInput, authorityDatabase: Db = db): Promise<void> {
  if (execution.schema === "paperclip.native-execution-input.v6") return dotRunnerBroker(db).assertRunAuthority(execution);
  if (execution.schema === "paperclip.native-execution-input.v8") return museRunnerBroker(db).assertRunAuthority(execution, authorityDatabase);
  throw new Error("external_native_execution_required");
}
