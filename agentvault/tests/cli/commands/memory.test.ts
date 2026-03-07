import { describe, it, expect } from 'vitest';
import { memoryCmd } from '../../../cli/commands/memory.js';

describe('memory CLI Command', () => {
  it('should have the correct name', () => {
    expect(memoryCmd.name()).toBe('memory');
  });

  it('should have a description mentioning memory repository', () => {
    expect(memoryCmd.description()).toContain('memory repository');
  });

  it('should have the --canister-id option', () => {
    const option = memoryCmd.options.find((o) => o.long === '--canister-id');
    expect(option).toBeDefined();
  });

  it('should have the --host option', () => {
    const option = memoryCmd.options.find((o) => o.long === '--host');
    expect(option).toBeDefined();
  });

  it('should have subcommand init', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'init');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('soul.md');
  });

  it('should have subcommand commit with required --diff option', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'commit');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('commit');
    const diffOpt = sub?.options.find((o) => o.long === '--diff');
    expect(diffOpt).toBeDefined();
    expect(diffOpt?.required).toBe(true);
  });

  it('should have subcommand log with --branch and --json options', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'log');
    expect(sub).toBeDefined();
    expect(sub?.options.find((o) => o.long === '--branch')).toBeDefined();
    expect(sub?.options.find((o) => o.long === '--json')).toBeDefined();
  });

  it('should have subcommand status', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'status');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('status');
  });

  it('should have subcommand branch', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'branch');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('branch');
  });

  it('should have subcommand checkout', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'checkout');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('Switch');
  });

  it('should have subcommand show with --json option', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'show');
    expect(sub).toBeDefined();
    expect(sub?.options.find((o) => o.long === '--json')).toBeDefined();
  });

  it('should have subcommand rebase with required --from-soul option', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'rebase');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('Rebase');
    const fromSoulOpt = sub?.options.find((o) => o.long === '--from-soul');
    expect(fromSoulOpt).toBeDefined();
    expect(fromSoulOpt?.required).toBe(true);
  });

  it('should have subcommand merge with required --from-branch and --strategy choices', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'merge');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('Merge');
    const fromBranchOpt = sub?.options.find((o) => o.long === '--from-branch');
    expect(fromBranchOpt).toBeDefined();
    expect(fromBranchOpt?.required).toBe(true);
    const strategyOpt = sub?.options.find((o) => o.long === '--strategy');
    expect(strategyOpt).toBeDefined();
  });

  it('should have subcommand cherry-pick', () => {
    const sub = memoryCmd.commands.find((c) => c.name() === 'cherry-pick');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('Cherry-pick');
  });

  it('should have all 10 subcommands', () => {
    expect(memoryCmd.commands).toHaveLength(10);
    const names = memoryCmd.commands.map(c => c.name()).sort();
    expect(names).toEqual([
      'branch',
      'checkout',
      'cherry-pick',
      'commit',
      'init',
      'log',
      'merge',
      'rebase',
      'show',
      'status',
    ]);
  });
});
