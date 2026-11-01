import type { NativeExecutionInputV6 } from "../../contracts/native-execution.js";
import type { ExternalBotProviderKind } from "../../contracts/external-provider.js";
import { DOT_EXTERNAL_CODEC, GROK_EXTERNAL_CODEC, RunnerdExternalDriver, describeRunnerdExternalDriver, type RunnerdExternalDriverOptions } from "../external/runnerd-external-driver.js";
export { externalRunnerExitMessage, runnerDisconnectDiagnostic } from "../external/runnerd-external-driver.js";
export interface RunnerdDotDriverOptions extends Omit<RunnerdExternalDriverOptions, "execution"> { execution: NativeExecutionInputV6 }
export function describeRunnerdExternalBotDriver(provider: ExternalBotProviderKind) {
  return describeRunnerdExternalDriver(provider === "grok_bot" ? GROK_EXTERNAL_CODEC : DOT_EXTERNAL_CODEC);
}
export function describeRunnerdDotDriver() { return describeRunnerdExternalBotDriver("openai_dot"); }
/** Compatibility wrapper: deployed V6 checkpoint, schema and command identities remain unchanged. */
export class RunnerdDotDriver extends RunnerdExternalDriver {
  constructor(options: RunnerdDotDriverOptions) { super(options, options.execution.provider.kind === "grok_bot" ? GROK_EXTERNAL_CODEC : DOT_EXTERNAL_CODEC); }
}
