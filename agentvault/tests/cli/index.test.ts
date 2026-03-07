import { describe, it, expect } from 'vitest';
import { createProgram } from '../../cli/index.js';

describe('CLI', () => {
  describe('createProgram', () => {
    it('should create a Commander program', () => {
      const program = createProgram();
      expect(program).toBeDefined();
      expect(program.name()).toBe('agentvault');
    });

    it('should have the correct description', () => {
      const program = createProgram();
      expect(program.description()).toContain('Persistent On-Chain AI Agent Platform');
    });

    it('should have version option configured', () => {
      const program = createProgram();
      const versionOption = program.options.find(
        (opt) => opt.short === '-v' || opt.long === '--version'
      );
      expect(versionOption).toBeDefined();
    });

    it('should have init command registered', () => {
      const program = createProgram();
      const initCmd = program.commands.find((cmd) => cmd.name() === 'init');
      expect(initCmd).toBeDefined();
      expect(initCmd?.description()).toContain('Initialize');
    });

    it('should have status command registered', () => {
      const program = createProgram();
      const statusCmd = program.commands.find((cmd) => cmd.name() === 'status');
      expect(statusCmd).toBeDefined();
      expect(statusCmd?.description()).toContain('status');
    });

    it('should have package command registered', () => {
      const program = createProgram();
      const packageCmd = program.commands.find((cmd) => cmd.name() === 'package');
      expect(packageCmd).toBeDefined();
      expect(packageCmd?.description()).toContain('WASM');
    });
  });
});
