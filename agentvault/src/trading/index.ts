/**
 * Trading Security Module
 *
 * Exports all components that implement the trading-specific threat model:
 *
 *   - ApiKeyManager: Binance API key storage with mandatory weekly rotation.
 *   - IpWhitelistManager: IP / CIDR allowlist with firewall rule generation.
 *   - SkillSandbox: Runtime sandbox enforcing no-root + /tmp write confinement
 *     for OpenClaw / Clawdbot skills.
 */

export {
  ApiKeyManager,
  getRotationStatus,
  isKeyValid,
  KEY_ROTATION_INTERVAL_DAYS,
} from './api-key-manager.js';
export type {
  BinanceApiKey,
  KeyRotationStatus,
} from './api-key-manager.js';

export {
  IpWhitelistManager,
  isIpAllowed,
  validateCidr,
  generateFirewallRules,
} from './ip-whitelist.js';
export type {
  WhitelistEntry,
  WhitelistValidationResult,
  FirewallRules,
} from './ip-whitelist.js';

export {
  SkillSandbox,
  defaultSandbox,
  SKILL_WRITE_ROOT,
} from './skill-sandbox.js';
export type {
  SandboxViolation,
} from './skill-sandbox.js';

export {
  TradeConsensusManager,
  buildVote,
  signVote,
  verifyVote,
  CONSENSUS_TIMEOUT_MS,
  REQUIRED_VOTES,
} from './consensus.js';
export type {
  AgentChain,
  TradeDirection,
  TradeSignal,
  ConsensusVote,
  ConsensusSession,
  ConsensusStatus,
  ConsensusManagerOptions,
} from './consensus.js';
