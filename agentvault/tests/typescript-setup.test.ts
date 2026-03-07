import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = join(import.meta.dirname, '..');

describe('TypeScript Project Setup', () => {
  describe('tsconfig.json', () => {
    const tsconfigPath = join(ROOT_DIR, 'tsconfig.json');

    it('should exist', () => {
      expect(existsSync(tsconfigPath)).toBe(true);
    });

    it('should be valid JSON', () => {
      const content = readFileSync(tsconfigPath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('should have strict mode enabled', () => {
      const content = readFileSync(tsconfigPath, 'utf-8');
      const tsconfig = JSON.parse(content);
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('should target ES2022 or later', () => {
      const content = readFileSync(tsconfigPath, 'utf-8');
      const tsconfig = JSON.parse(content);
      expect(tsconfig.compilerOptions.target).toMatch(/^ES20(2[2-9]|[3-9]\d)$/);
    });

    it('should use NodeNext module resolution', () => {
      const content = readFileSync(tsconfigPath, 'utf-8');
      const tsconfig = JSON.parse(content);
      expect(tsconfig.compilerOptions.moduleResolution).toBe('NodeNext');
    });

    it('should output to dist directory', () => {
      const content = readFileSync(tsconfigPath, 'utf-8');
      const tsconfig = JSON.parse(content);
      expect(tsconfig.compilerOptions.outDir).toBe('./dist');
    });

    it('should include src directory', () => {
      const content = readFileSync(tsconfigPath, 'utf-8');
      const tsconfig = JSON.parse(content);
      expect(tsconfig.include).toContain('src/**/*');
    });
  });

  describe('src/index.ts', () => {
    const indexPath = join(ROOT_DIR, 'src', 'index.ts');

    it('should exist', () => {
      expect(existsSync(indexPath)).toBe(true);
    });

    it('should export VERSION constant', () => {
      const content = readFileSync(indexPath, 'utf-8');
      expect(content).toContain('export const VERSION');
    });

    it('should export AgentVaultConfig interface', () => {
      const content = readFileSync(indexPath, 'utf-8');
      expect(content).toContain('export interface AgentVaultConfig');
    });

    it('should export createConfig function', () => {
      const content = readFileSync(indexPath, 'utf-8');
      expect(content).toContain('export function createConfig');
    });
  });

  describe('vitest.config.ts', () => {
    const vitestConfigPath = join(ROOT_DIR, 'vitest.config.ts');

    it('should exist', () => {
      expect(existsSync(vitestConfigPath)).toBe(true);
    });

    it('should include tests directory', () => {
      const content = readFileSync(vitestConfigPath, 'utf-8');
      expect(content).toContain('tests/**/*.test.ts');
    });
  });

  describe('ESLint configuration', () => {
    const eslintConfigPath = join(ROOT_DIR, 'eslint.config.js');

    it('should exist', () => {
      expect(existsSync(eslintConfigPath)).toBe(true);
    });

    it('should use typescript-eslint', () => {
      const content = readFileSync(eslintConfigPath, 'utf-8');
      expect(content).toContain('typescript-eslint');
    });
  });

  describe('package.json scripts', () => {
    const packageJsonPath = join(ROOT_DIR, 'package.json');

    it('should have build script', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.scripts.build).toBe('tsc');
    });

    it('should have test script', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.scripts.test).toBeDefined();
    });

    it('should have lint script', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.scripts.lint).toBe('eslint .');
    });

    it('should have typecheck script', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    });
  });

  describe('TypeScript devDependencies', () => {
    const packageJsonPath = join(ROOT_DIR, 'package.json');

    it('should have typescript as devDependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.devDependencies.typescript).toBeDefined();
    });

    it('should have @types/node as devDependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.devDependencies['@types/node']).toBeDefined();
    });

    it('should have eslint as devDependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.devDependencies.eslint).toBeDefined();
    });

    it('should have vitest as devDependency', () => {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      expect(pkg.devDependencies.vitest).toBeDefined();
    });
  });
});
