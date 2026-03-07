import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as esbuild from 'esbuild';
import {
  generateWasm,
  generateWat,
  generateStateJson,
  compileToWasm,
  validateWasmFile,
} from '../../src/packaging/compiler.js';
import type { AgentConfig } from '../../src/packaging/types.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock esbuild
vi.mock('esbuild', () => ({
  build: vi.fn().mockResolvedValue({
    errors: [],
    warnings: [],
    outputFiles: [{ text: 'console.log("bundled");', path: '', contents: new Uint8Array() }],
  }),
}));

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock esbuild
vi.mock('esbuild', () => ({
  build: vi.fn().mockResolvedValue({
    errors: [],
    warnings: [],
    outputFiles: [{ text: 'console.log("bundled");', path: '', contents: new Uint8Array() }],
  }),
}));

describe('compiler', () => {
  const mockConfig: AgentConfig = {
    name: 'test-agent',
    type: 'clawdbot',
    sourcePath: '/path/to/agent',
    entryPoint: 'index.ts',
    version: '1.0.0',
  };

  const mockAgentCode = 'console.log("hello");';

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock entry point file existence
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).includes('/path/to/agent/index.ts');
    });
    // Mock entry point file content
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (String(path).includes('/path/to/agent/index.ts')) {
        return mockAgentCode;
      }
      return Buffer.from([]);
    });
  });

  describe('generateWasm', () => {
    it('should generate a valid WASM buffer with magic bytes', () => {
      const jsBundle = 'console.log("test");';
      const wasm = generateWasm(mockConfig, jsBundle);

      expect(Buffer.isBuffer(wasm)).toBe(true);
      // Check WASM magic bytes
      expect(wasm[0]).toBe(0x00);
      expect(wasm[1]).toBe(0x61); // 'a'
      expect(wasm[2]).toBe(0x73); // 's'
      expect(wasm[3]).toBe(0x6d); // 'm'
    });

    it('should generate a WASM buffer with version 1', () => {
      const jsBundle = 'console.log("test");';
      const wasm = generateWasm(mockConfig, jsBundle);

      // Check version bytes (bytes 4-7)
      expect(wasm[4]).toBe(0x01);
      expect(wasm[5]).toBe(0x00);
      expect(wasm[6]).toBe(0x00);
      expect(wasm[7]).toBe(0x00);
    });

    it('should include agent name in WASM binary', () => {
      const jsBundle = 'console.log("test");';
      const wasm = generateWasm(mockConfig, jsBundle);

      // The agent name should be somewhere in the binary
      const wasmString = wasm.toString('utf-8');
      expect(wasmString).toContain('test-agent');
    });

    it('should embed JavaScript bundle in WASM', () => {
      const jsBundle = 'console.log("test");';
      const wasm = generateWasm(mockConfig, jsBundle);

      const wasmString = wasm.toString('utf-8');
      expect(wasmString).toContain('console.log');
    });

    it('should generate different sizes for different agent names', () => {
      const shortNameConfig = { ...mockConfig, name: 'a' };
      const longNameConfig = { ...mockConfig, name: 'very-long-agent-name' };

      const jsBundle = 'console.log("test");';
      const shortWasm = generateWasm(shortNameConfig, jsBundle);
      const longWasm = generateWasm(longNameConfig, jsBundle);

      expect(longWasm.length).toBeGreaterThan(shortWasm.length);
    });
  });

  describe('generateWat', () => {
    it('should generate valid WAT format', () => {
      const jsBundle = 'console.log("test");';
      const wat = generateWat(mockConfig, jsBundle);

      expect(typeof wat).toBe('string');
      expect(wat).toContain('(module');
      expect(wat).toContain(')');
    });

    it('should include agent name in WAT', () => {
      const wat = generateWat(mockConfig, 'console.log("test");');

      expect(wat).toContain('test-agent');
    });

    it('should include agent type in WAT', () => {
      const wat = generateWat(mockConfig, 'console.log("test");');

      expect(wat).toContain('clawdbot');
    });

    it('should export required functions', () => {
      const wat = generateWat(mockConfig, 'console.log("test");');

      expect(wat).toContain('(export "init")');
      expect(wat).toContain('(export "step")');
      expect(wat).toContain('(export "memory")');
      expect(wat).toContain('(export "get_state_ptr")');
      expect(wat).toContain('(export "get_state_size")');
    });
  });

  describe('generateStateJson', () => {
    it('should generate valid JSON', () => {
      const stateJson = generateStateJson(mockConfig);

      expect(() => JSON.parse(stateJson)).not.toThrow();
    });

    it('should include agent metadata', () => {
      const stateJson = generateStateJson(mockConfig);
      const state = JSON.parse(stateJson);

      expect(state.agent.name).toBe('test-agent');
      expect(state.agent.type).toBe('clawdbot');
      expect(state.agent.version).toBe('1.0.0');
    });

    it('should include source path in metadata', () => {
      const stateJson = generateStateJson(mockConfig);
      const state = JSON.parse(stateJson);

      expect(state.metadata.sourcePath).toBe('/path/to/agent');
      expect(state.metadata.entryPoint).toBe('index.ts');
    });

    it('should include schema reference', () => {
      const stateJson = generateStateJson(mockConfig);
      const state = JSON.parse(stateJson);

      expect(state.$schema).toBe('https://agentvault.dev/schemas/agent-state-v1.json');
    });

    it('should initialize state as not initialized', () => {
      const stateJson = generateStateJson(mockConfig);
      const state = JSON.parse(stateJson);

      expect(state.state.initialized).toBe(false);
      expect(state.state.data).toEqual({});
    });

    it('should use default version when not specified', () => {
      const configWithoutVersion = { ...mockConfig, version: undefined };
      const stateJson = generateStateJson(configWithoutVersion);
      const state = JSON.parse(stateJson);

      expect(state.agent.version).toBe('1.0.0');
    });
  });

  describe('compileToWasm', () => {
    const mockOptions = {
      sourcePath: '/path/to/agent',
      target: 'wasmedge' as const,
      debug: true,
      optimize: 2,
    };

    it('should create output directory if it does not exist', async () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        // Output directory doesn't exist
        return String(path).includes('/path/to/agent/index.ts');
      });

      await compileToWasm(mockConfig, mockOptions, '/output/dir');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/output/dir', { recursive: true });
    });

    it('should not create directory if it exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await compileToWasm(mockConfig, mockOptions, '/output/dir');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should bundle agent code', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await compileToWasm(mockConfig, mockOptions, '/output/dir');

      expect(vi.mocked(esbuild.build)).toHaveBeenCalledWith(
        expect.objectContaining({
          entryPoints: ['/path/to/agent/index.ts'],
        })
      );
    });

     it('should write output files', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await compileToWasm(mockConfig, mockOptions, '/output/dir');

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
      const paths = writeCalls.map((call) => call[0] as string);

      // Core files that should always be written
      expect(paths).toContain('/output/dir/test-agent.wasm');
      expect(paths).toContain('/output/dir/test-agent.wat');
      expect(paths).toContain('/output/dir/test-agent.state.json');

      // Conditional files based on target
      if (result.target === 'wasmedge') {
        expect(paths).toContain('/output/dir/test-agent.bundle.js');
        expect(paths).toContain('/output/dir/test-agent.wasmedge.json');
        expect(paths).toContain('/output/dir/test-agent.manifest.json');
      }
    });

    it('should write files with correct names', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await compileToWasm(mockConfig, mockOptions, '/output/dir');

      const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
      const paths = writeCalls.map((call) => call[0] as string);

      expect(paths).toContain('/output/dir/test-agent.wasm');
      expect(paths).toContain('/output/dir/test-agent.wat');
      expect(paths).toContain('/output/dir/test-agent.state.json');
      expect(paths).toContain('/output/dir/test-agent.bundle.js');
    });

    it('should return package result with correct paths', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await compileToWasm(mockConfig, mockOptions, '/output/dir');

      expect(result.wasmPath).toBe('/output/dir/test-agent.wasm');
      expect(result.watPath).toBe('/output/dir/test-agent.wat');
      expect(result.statePath).toBe('/output/dir/test-agent.state.json');
    });

    it('should return package result with wasm size', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await compileToWasm(mockConfig, mockOptions, '/output/dir');

      expect(result.wasmSize).toBeGreaterThan(0);
    });

    it('should return package result with timestamp', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await compileToWasm(mockConfig, mockOptions, '/output/dir');

      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should return package result with config', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await compileToWasm(mockConfig, mockOptions, '/output/dir');

      expect(result.config).toEqual(mockConfig);
    });
  });

  describe('validateWasmFile', () => {
    it('should return true for valid WASM file', () => {
      const validWasm = Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d]), // magic
        Buffer.from([0x01, 0x00, 0x00, 0x00]), // version
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(validWasm);

      const result = validateWasmFile('/path/to/valid.wasm');

      expect(result).toBe(true);
    });

    it('should return false for file with invalid magic bytes', () => {
      const invalidWasm = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
      vi.mocked(fs.readFileSync).mockReturnValue(invalidWasm);

      const result = validateWasmFile('/path/to/invalid.wasm');

      expect(result).toBe(false);
    });

    it('should return false for file with invalid version', () => {
      const invalidVersion = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
      vi.mocked(fs.readFileSync).mockReturnValue(invalidVersion);

      const result = validateWasmFile('/path/to/invalid.wasm');

      expect(result).toBe(false);
    });

    it('should return false for file that is too small', () => {
      const tooSmall = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
      vi.mocked(fs.readFileSync).mockReturnValue(tooSmall);

      const result = validateWasmFile('/path/to/small.wasm');

      expect(result).toBe(false);
    });

    it('should return false when file read fails', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('File not found');
      });

      const result = validateWasmFile('/path/to/nonexistent.wasm');

      expect(result).toBe(false);
    });
  });
});
