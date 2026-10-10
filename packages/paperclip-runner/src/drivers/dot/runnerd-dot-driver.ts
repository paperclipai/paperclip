import type { NativeExecutionInputV6 } from "../../contracts/native-execution.js";
import { DOT_EXTERNAL_CODEC, RunnerdExternalDriver, describeRunnerdExternalDriver, type RunnerdExternalDriverOptions } from "../external/runnerd-external-driver.js";
export interface RunnerdDotDriverOptions extends Omit<RunnerdExternalDriverOptions, "execution"> { execution: NativeExecutionInputV6 }
export function describeRunnerdDotDriver() { return describeRunnerdExternalDriver(DOT_EXTERNAL_CODEC); }
/** Compatibility wrapper: Dot checkpoint, schema and command identities remain deployed V6. */
export class RunnerdDotDriver extends RunnerdExternalDriver {
  constructor(options: RunnerdDotDriverOptions) { super(options, DOT_EXTERNAL_CODEC); }
}
