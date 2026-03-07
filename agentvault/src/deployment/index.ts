/**
 * Deployment Module
 *
 * Exports all deployment-related functionality.
 */

// Types
export type {
  NetworkType,
  DeploymentStatus,
  CanisterInfo,
  DeployOptions,
  DeployResult,
  DeploymentError,
  ICPClientConfig,
} from './types.js';

// ICP Client
export {
  ICPClient,
  createICPClient,
  generateStubCanisterId,
} from './icpClient.js';

// Deployer
export {
  deployAgent,
  validateDeployOptions,
  getDeploySummary,
  getCanisterStatus,
} from './deployer.js';

// Promotion
export {
  loadDeploymentHistory,
  saveDeploymentHistory,
  addDeploymentToHistory,
  getLatestDeployment,
  getAllDeployments,
  promoteCanister,
  getDeploymentForRollback,
  getDeploymentsByTimeRange,
} from './promotion.js';

// Batched operations
export * from '../icp/batch.js';
