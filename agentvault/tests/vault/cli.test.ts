/**
 * Vault CLI command registration tests
 *
 * Tests the vaultCmd directly to avoid the pre-existing @polkadot/keyring
 * missing dependency issue in the full CLI index import chain.
 */

import { describe, it, expect } from 'vitest';
import { vaultCmd } from '../../cli/commands/vault.js';

describe('Vault CLI Command', () => {
  it('should have the correct name', () => {
    expect(vaultCmd.name()).toBe('vault');
  });

  it('should have a description mentioning secrets', () => {
    expect(vaultCmd.description()).toContain('secrets');
  });

  it('should have init subcommand', () => {
    const initSubcommand = vaultCmd.commands.find((cmd) => cmd.name() === 'init');
    expect(initSubcommand).toBeDefined();
    expect(initSubcommand?.description()).toContain('Configure');
  });

  it('should have health subcommand', () => {
    const healthSubcommand = vaultCmd.commands.find((cmd) => cmd.name() === 'health');
    expect(healthSubcommand).toBeDefined();
    expect(healthSubcommand?.description()).toContain('health');
  });

  it('should have get subcommand', () => {
    const getSubcommand = vaultCmd.commands.find((cmd) => cmd.name() === 'get');
    expect(getSubcommand).toBeDefined();
    expect(getSubcommand?.description()).toContain('Retrieve');
  });

  it('should have put subcommand', () => {
    const putSubcommand = vaultCmd.commands.find((cmd) => cmd.name() === 'put');
    expect(putSubcommand).toBeDefined();
    expect(putSubcommand?.description()).toContain('Store');
  });

  it('should have list subcommand', () => {
    const listSubcommand = vaultCmd.commands.find((cmd) => cmd.name() === 'list');
    expect(listSubcommand).toBeDefined();
    expect(listSubcommand?.description()).toContain('List');
  });

  it('should have delete subcommand', () => {
    const deleteSubcommand = vaultCmd.commands.find((cmd) => cmd.name() === 'delete');
    expect(deleteSubcommand).toBeDefined();
    expect(deleteSubcommand?.description()).toContain('Delete');
  });

  it('should have policy subcommand', () => {
    const policySubcommand = vaultCmd.commands.find((cmd) => cmd.name() === 'policy');
    expect(policySubcommand).toBeDefined();
    expect(policySubcommand?.description()).toContain('policy');
  });

  it('should have all 8 subcommands', () => {
    expect(vaultCmd.commands).toHaveLength(8);
    const subcommandNames = vaultCmd.commands.map(c => c.name()).sort();
    expect(subcommandNames).toEqual(['delete', 'get', 'health', 'init', 'list', 'policy', 'put', 'store']);
  });
});
