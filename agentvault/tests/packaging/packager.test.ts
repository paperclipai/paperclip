import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { packageAgent, validateAgent, getPackageSummary } from '../../src/packaging/packager.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe('packager', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Mock compileToWasm to return a fake result by default
    const compilerModule = await import('../../src/packaging/compiler.js');
    vi.spyOn(compilerModule, 'compileToWasm').mockResolvedValue({
      config: { name: 'agent', type: 'generic', sourcePath: '/path/to/agent', entryPoint: 'index.ts', version: '1.0.0' },
      wasmPath: '/path/to/agent/dist/agent.wasm',
      watPath: '/path/to/agent/dist/agent.wat',
      statePath: '/path/to/agent/dist/agent.state.json',
      wasmSize: 1024,
      target: 'wasmedge',
      timestamp: new Date(),
      duration: 100,
      functionCount: 14,
    } as any);
  });

  describe('validateAgent', () => {
    it('should return valid for existing directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const result = validateAgent('/path/to/agent');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return error for non-existent path', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = validateAgent('/nonexistent/path');

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.code).toBe('INVALID_SOURCE_PATH');
    });

    it('should warn when no entry point detected', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        // Only return true for the base path, not for entry point checks
        return String(p) === '/path/to/agent' || String(p).endsWith('/path/to/agent');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const result = validateAgent('/path/to/agent');

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes('entry point'))).toBe(true);
    });

    it('should warn when agent type is generic', () => {
      // Mock so that only the base path exists, not any agent-specific config files
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = String(p);
        // Return true only for the base directory, not for any config files
        return pathStr === '/path/to/agent' || pathStr.endsWith('/to/agent');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const result = validateAgent('/path/to/agent');

      expect(result.warnings.some((w) => w.includes('generic'))).toBe(true);
    });
  });

  describe('getPackageSummary', () => {
    it('should return config and validation', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const summary = getPackageSummary('/path/to/my-agent');

      expect(summary.config).toBeDefined();
      expect(summary.config.name).toBe('my-agent');
      expect(summary.validation).toBeDefined();
      expect(summary.validation.valid).toBe(true);
    });

    it('should include validation errors in summary', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const summary = getPackageSummary('/nonexistent/path');

      expect(summary.validation.valid).toBe(false);
      expect(summary.validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('packageAgent', () => {
    it('should throw when validation fails', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(packageAgent({ sourcePath: '/nonexistent/path' })).rejects.toThrow(
        'Validation failed'
      );
    });

    it('should skip validation when skipValidation is true', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      // This would normally fail validation but should succeed with skipValidation
      await expect(
        packageAgent({ sourcePath: '/valid/path', skipValidation: true })
      ).resolves.toBeDefined();
    });

    it('should use default output directory when not specified', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);
      // Mock compileToWasm to return a fake result
      const compilerModule = await import('../../src/packaging/compiler.js');
      vi.spyOn(compilerModule, 'compileToWasm').mockResolvedValue({
        config: { name: 'agent', type: 'generic', sourcePath: '/path/to/agent', entryPoint: 'index.ts', version: '1.0.0' },
        wasmPath: '/path/to/agent/dist/agent.wasm',
        watPath: '/path/to/agent/dist/agent.wat',
        statePath: '/path/to/agent/dist/agent.state.json',
        wasmSize: 1024,
        target: 'wasmedge',
        timestamp: new Date(),
        duration: 100,
        functionCount: 14,
      } as any);

      const result = await packageAgent({ sourcePath: '/path/to/agent' });

      expect(result.wasmPath).toContain('dist');
    });

    it('should use specified output directory', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);
      // Mock compileToWasm to return a fake result
      const compilerModule = await import('../../src/packaging/compiler.js');
      vi.spyOn(compilerModule, 'compileToWasm').mockResolvedValue({
        config: { name: 'agent', type: 'generic', sourcePath: '/path/to/agent', entryPoint: 'index.ts', version: '1.0.0' },
        wasmPath: '/custom/output/agent.wasm',
        watPath: '/custom/output/agent.wat',
        statePath: '/custom/output/agent.state.json',
        wasmSize: 1024,
        target: 'wasmedge',
        timestamp: new Date(),
        duration: 100,
        functionCount: 14,
      } as any);

      const result = await packageAgent({
        sourcePath: '/path/to/agent',
        outputPath: '/custom/output',
      });

      expect(result.wasmPath).toContain('/custom/output');
    });

    it('should return package result with all required fields', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);
      // Mock compileToWasm to return a fake result
      const compilerModule = await import('../../src/packaging/compiler.js');
      vi.spyOn(compilerModule, 'compileToWasm').mockResolvedValue({
        config: { name: 'agent', type: 'generic', sourcePath: '/path/to/agent', entryPoint: 'index.ts', version: '1.0.0' },
        wasmPath: '/path/to/agent/dist/agent.wasm',
        watPath: '/path/to/agent/dist/agent.wat',
        statePath: '/path/to/agent/dist/agent.state.json',
        wasmSize: 1024,
        target: 'wasmedge',
        timestamp: new Date(),
        duration: 100,
        functionCount: 14,
      } as any);

      const result = await packageAgent({ sourcePath: '/path/to/agent' });

      expect(result.config).toBeDefined();
      expect(result.wasmPath).toBeDefined();
      expect(result.watPath).toBeDefined();
      expect(result.statePath).toBeDefined();
      expect(result.wasmSize).toBeGreaterThan(0);
      expect(result.timestamp).toBeInstanceOf(Date);
    });
  });
});
