/** Stable App-owned integration surface for Paperclip Evals. */
export * from "./build-metadata.js";
export * from "./compatibility.js";
export * from "./native-execution.js";
export * from "./runnerd-artifact.js";

export {
  PRP_PROTOCOL_NAME,
  PRP_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  validatePrpEvent,
  validatePrpFixture,
  validatePrpStructuredRunResult,
  type PrpCapabilities,
  type PrpEvent,
  type PrpSemanticToolEnvelope,
  type PrpStructuredRunResult,
  type PrpTerminalState,
} from "../protocol/replay-contract.js";
export * from "../protocol/semantic-tool-receipts.js";
export {
  CAPABILITY_SEMANTIC_TOOL_CATALOG,
  canonicalCapabilitySemanticCatalog,
  capabilitySemanticToolDescriptor,
} from "../semantic-tools/catalog.js";
export type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessSession,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
} from "../contracts/harness-driver.js";
