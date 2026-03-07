import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = join(import.meta.dirname, '..');

describe('CLI Framework', () => {
  describe('CLI entry point (cli/index.ts)', () => {
    const cliIndexPath = join(ROOT_DIR, 'cli', 'index.ts');

    it('should exist', () => {
      expect(existsSync(cliIndexPath)).toBe(true);
    });

    it('should have shebang for CLI execution', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    it('should import Commander', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content).toContain("import { Command } from 'commander'");
    });

    it('should export createProgram function', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content).toContain('export function createProgram');
    });

    it('should export run function', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content).toContain('export async function run');
    });

    it('should set program name to agentvault', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content).toContain(".name('agentvault')");
    });

    it('should configure version option', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content).toContain('.version(');
      expect(content).toContain('-v, --version');
    });

    it('should register init command', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content).toContain('program.addCommand(initCommand())');
    });

    it('should register status command', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content).toContain('program.addCommand(statusCommand())');
    });

    it('should register package command', () => {
      const content = readFileSync(cliIndexPath, 'utf-8');
      expect(content).toContain('program.addCommand(packageCommand())');
    });
  });

  describe('Init command (cli/commands/init.ts)', () => {
    const initPath = join(ROOT_DIR, 'cli', 'commands', 'init.ts');

    it('should exist', () => {
      expect(existsSync(initPath)).toBe(true);
    });

    it('should import Commander', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain("import { Command } from 'commander'");
    });

    it('should import Inquirer', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain("import inquirer from 'inquirer'");
    });

    it('should import chalk for colored output', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain("import chalk from 'chalk'");
    });

    it('should import ora for spinners', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain("import ora from 'ora'");
    });

    it('should export initCommand function', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain('export function initCommand');
    });

    it('should export promptForInitOptions function', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain('export async function promptForInitOptions');
    });

    it('should export executeInit function', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain('export async function executeInit');
    });

    it('should support --name option', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain('-n, --name <name>');
    });

    it('should support --yes option for non-interactive mode', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain('-y, --yes');
    });

    it('should validate agent name format', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain('validate:');
      expect(content).toContain('[a-z0-9-]');
    });

    it('should export InitOptions interface', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain('export interface InitOptions');
    });

    it('should export InitAnswers interface', () => {
      const content = readFileSync(initPath, 'utf-8');
      expect(content).toContain('export interface InitAnswers');
    });
  });

  describe('Status command (cli/commands/status.ts)', () => {
    const statusPath = join(ROOT_DIR, 'cli', 'commands', 'status.ts');

    it('should exist', () => {
      expect(existsSync(statusPath)).toBe(true);
    });

    it('should import Commander', () => {
      const content = readFileSync(statusPath, 'utf-8');
      expect(content).toContain("import { Command } from 'commander'");
    });

    it('should import chalk for colored output', () => {
      const content = readFileSync(statusPath, 'utf-8');
      expect(content).toContain("import chalk from 'chalk'");
    });

    it('should import ora for spinners', () => {
      const content = readFileSync(statusPath, 'utf-8');
      expect(content).toContain("import ora from 'ora'");
    });

    it('should export statusCommand function', () => {
      const content = readFileSync(statusPath, 'utf-8');
      expect(content).toContain('export function statusCommand');
    });

    it('should export getProjectStatus function', () => {
      const content = readFileSync(statusPath, 'utf-8');
      expect(content).toContain('export async function getProjectStatus');
    });

    it('should export displayStatus function', () => {
      const content = readFileSync(statusPath, 'utf-8');
      expect(content).toContain('export async function displayStatus');
    });

    it('should support --json option', () => {
      const content = readFileSync(statusPath, 'utf-8');
      expect(content).toContain('-j, --json');
    });

    it('should export ProjectStatus interface', () => {
      const content = readFileSync(statusPath, 'utf-8');
      expect(content).toContain('export interface ProjectStatus');
    });
  });

  describe('Package command (cli/commands/package.ts)', () => {
    const packagePath = join(ROOT_DIR, 'cli', 'commands', 'package.ts');

    it('should exist', () => {
      expect(existsSync(packagePath)).toBe(true);
    });

    it('should import Commander', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain("import { Command } from 'commander'");
    });

    it('should import chalk for colored output', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain("import chalk from 'chalk'");
    });

    it('should import ora for spinners', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain("import ora from 'ora'");
    });

    it('should export packageCommand function', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain('export function packageCommand');
    });

    it('should export executePackage function', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain('export async function executePackage');
    });

    it('should support --output option', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain('-o, --output <path>');
    });

    it('should support --force option', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain('-f, --force');
    });

    it('should support --dry-run option', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain('--dry-run');
    });

    it('should support --skip-validation option', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain('--skip-validation');
    });

    it('should export PackageCommandOptions interface', () => {
      const content = readFileSync(packagePath, 'utf-8');
      expect(content).toContain('export interface PackageCommandOptions');
    });
  });

  describe('package.json CLI configuration', () => {
    const packageJsonPath = join(ROOT_DIR, 'package.json');

    it('should have bin entry for CLI', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.bin).toBeDefined();
      expect(pkg.bin.agentvault).toBe('dist/cli/index.js');
    });

    it('should have commander dependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.dependencies.commander).toBeDefined();
    });

    it('should have inquirer dependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.dependencies.inquirer).toBeDefined();
    });

    it('should have chalk dependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.dependencies.chalk).toBeDefined();
    });

    it('should have ora dependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.dependencies.ora).toBeDefined();
    });

    it('should have @types/inquirer devDependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.devDependencies['@types/inquirer']).toBeDefined();
    });
  });
});

describe('CLI Framework Runtime', { timeout: 15000 }, () => {
  describe('createProgram', () => {
    it('should create a Commander program', async () => {
      const { createProgram } = await import('../cli/index.js');
      const program = createProgram();
      expect(program).toBeDefined();
      expect(program.name()).toBe('agentvault');
    });

    it('should have correct version', async () => {
      const { createProgram } = await import('../cli/index.js');
      const { VERSION } = await import('../src/index.js');
      const program = createProgram();
      expect(program.version()).toBe(VERSION);
    });

    it('should have init command registered', async () => {
      const { createProgram } = await import('../cli/index.js');
      const program = createProgram();
      const initCmd = program.commands.find((cmd) => cmd.name() === 'init');
      expect(initCmd).toBeDefined();
    });

    it('should have status command registered', async () => {
      const { createProgram } = await import('../cli/index.js');
      const program = createProgram();
      const statusCmd = program.commands.find((cmd) => cmd.name() === 'status');
      expect(statusCmd).toBeDefined();
    });

    it('should have package command registered', async () => {
      const { createProgram } = await import('../cli/index.js');
      const program = createProgram();
      const packageCmd = program.commands.find((cmd) => cmd.name() === 'package');
      expect(packageCmd).toBeDefined();
    });
  });

  describe('initCommand', () => {
    it('should create a command named init', async () => {
      const { initCommand } = await import('../cli/commands/init.js');
      const cmd = initCommand();
      expect(cmd.name()).toBe('init');
    });

    it('should have --name option', async () => {
      const { initCommand } = await import('../cli/commands/init.js');
      const cmd = initCommand();
      const nameOption = cmd.options.find((opt) => opt.long === '--name');
      expect(nameOption).toBeDefined();
    });

    it('should have --yes option', async () => {
      const { initCommand } = await import('../cli/commands/init.js');
      const cmd = initCommand();
      const yesOption = cmd.options.find((opt) => opt.long === '--yes');
      expect(yesOption).toBeDefined();
    });
  });

  describe('statusCommand', () => {
    it('should create a command named status', async () => {
      const { statusCommand } = await import('../cli/commands/status.js');
      const cmd = statusCommand();
      expect(cmd.name()).toBe('status');
    });

    it('should have --json option', async () => {
      const { statusCommand } = await import('../cli/commands/status.js');
      const cmd = statusCommand();
      const jsonOption = cmd.options.find((opt) => opt.long === '--json');
      expect(jsonOption).toBeDefined();
    });
  });

  describe('packageCommand', () => {
    it('should create a command named package', async () => {
      const { packageCommand } = await import('../cli/commands/package.js');
      const cmd = packageCommand();
      expect(cmd.name()).toBe('package');
    });

    it('should have --output option', async () => {
      const { packageCommand } = await import('../cli/commands/package.js');
      const cmd = packageCommand();
      const outputOption = cmd.options.find((opt) => opt.long === '--output');
      expect(outputOption).toBeDefined();
    });

    it('should have --force option', async () => {
      const { packageCommand } = await import('../cli/commands/package.js');
      const cmd = packageCommand();
      const forceOption = cmd.options.find((opt) => opt.long === '--force');
      expect(forceOption).toBeDefined();
    });

    it('should have --dry-run option', async () => {
      const { packageCommand } = await import('../cli/commands/package.js');
      const cmd = packageCommand();
      const dryRunOption = cmd.options.find((opt) => opt.long === '--dry-run');
      expect(dryRunOption).toBeDefined();
    });
  });

  describe('promptForInitOptions', () => {
    it('should return defaults when --yes flag is used', async () => {
      const { promptForInitOptions } = await import('../cli/commands/init.js');
      const result = await promptForInitOptions({ yes: true });
      expect(result).toEqual({
        name: 'my-agent',
        description: 'An AgentVault agent',
        confirm: true,
      });
    });

    it('should use provided name with --yes flag', async () => {
      const { promptForInitOptions } = await import('../cli/commands/init.js');
      const result = await promptForInitOptions({ yes: true, name: 'custom-agent' });
      expect(result).toEqual({
        name: 'custom-agent',
        description: 'An AgentVault agent',
        confirm: true,
      });
    });
  });

  describe('getProjectStatus', () => {
    it('should return project status object', async () => {
      const { getProjectStatus } = await import('../cli/commands/status.js');
      const status = await getProjectStatus();
      expect(status).toHaveProperty('initialized');
      expect(status).toHaveProperty('version');
      expect(status).toHaveProperty('agentName');
      expect(status).toHaveProperty('canisterDeployed');
    });
  });
});
