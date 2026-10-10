import type { NativeExecutionInputV7 } from "../../contracts/native-execution.js";
import type { ExternalProviderPort } from "../../contracts/external-provider.js";
import { MUSE_EXTERNAL_CODEC, RunnerdExternalDriver, describeRunnerdExternalDriver, type RunnerdExternalDriverOptions } from "../external/runnerd-external-driver.js";
export interface RunnerdMuseDriverOptions extends Omit<RunnerdExternalDriverOptions, "execution" | "port"> {
  execution: NativeExecutionInputV7;
  port: ExternalProviderPort & Required<Pick<ExternalProviderPort, "inputAvailable">>;
}
export function describeRunnerdMuseDriver() { return describeRunnerdExternalDriver(MUSE_EXTERNAL_CODEC); }
export class RunnerdMuseDriver extends RunnerdExternalDriver {
  constructor(options: RunnerdMuseDriverOptions) { super(options, MUSE_EXTERNAL_CODEC); }
}
