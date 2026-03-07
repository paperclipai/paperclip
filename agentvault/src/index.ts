/**
 * AgentVault - Persistent On-Chain AI Agent Platform
 *
 * Sovereign, Reconstructible, Autonomous
 */

export const VERSION = '1.0.0';

export interface AgentVaultConfig {
  name: string;
  version: string;
}

export function createConfig(name: string): AgentVaultConfig {
  return {
    name,
    version: VERSION,
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`AgentVault v${VERSION}`);
  console.log('Persistent On-Chain AI Agent Platform');
}
