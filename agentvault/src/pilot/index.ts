/**
 * AgentVault Pilot Module
 *
 * First-class support for deploying a fully private ICP replica
 * (local or air-gapped) so companies can run the entire AgentVault
 * Guild with zero external exposure or mainnet cycles cost.
 *
 * Supports PRD-004: Internal Pilot – Private ICP Replica for Company Guild
 */

// Types
export type {
  ReplicaType,
  StackTarget,
  AirGapConfig,
  ProxyConfig,
  PrivateReplicaConfig,
  PilotInitResult,
  PilotDeployResult,
  PilotStatus,
  PilotStep,
  PilotInitOptions,
  PilotDeployOptions,
  MdnsReplicaRecord,
  PilotConfigFile,
} from './types.js';

// Private replica lifecycle
export {
  DEFAULT_REPLICA_PORT,
  DEFAULT_BIND_ADDRESS,
  buildReplicaUrl,
  getPilotConfigPath,
  getStateDir,
  loadPilotConfig,
  savePilotConfig,
  buildPrivateReplicaConfig,
  isDfxAvailable,
  initPrivateReplica,
  getPrivateReplicaStatus,
  stopPrivateReplica,
  listPilotCompanies,
  replicaTypeLabel,
} from './private-replica.js';

// Air-gap mode
export {
  DEFAULT_ALLOWED_ENDPOINTS,
  buildAirGapConfig,
  buildAirGapEnv,
  validateAirGapConfig,
  writeAirGapEnvFile,
  toggleAirGap,
  describeAirGap,
} from './air-gap.js';

// Proxy configuration
export {
  buildProxyConfig,
  proxyConfigToEnv,
  validateProxyConfig,
  describeProxyConfig,
} from './proxy-config.js';
