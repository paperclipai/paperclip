/**
 * Tests for ic-wasm wrapper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execa before importing the module
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import * as icwasm from '../../src/icp/icwasm.js';
import { execa } from 'execa';

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ic-wasm optimize', () => {
  it('should call ic-wasm with correct optimize arguments', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'Optimized successfully', stderr: '' });

    const result = await icwasm.optimize({
      input: '/tmp/input.wasm',
      output: '/tmp/output.wasm',
      level: 'O3',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'optimize', '-o', '/tmp/output.wasm', '--O3'],
      expect.objectContaining({ reject: false }),
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('Optimized successfully');
  });

  it('should omit level flag when not specified', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await icwasm.optimize({
      input: '/tmp/input.wasm',
      output: '/tmp/output.wasm',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'optimize', '-o', '/tmp/output.wasm'],
      expect.any(Object),
    );
  });

  it('should report failure when exit code is non-zero', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Error: invalid wasm' });

    const result = await icwasm.optimize({
      input: '/tmp/bad.wasm',
      output: '/tmp/output.wasm',
    });

    expect(result.success).toBe(false);
    expect(result.stderr).toBe('Error: invalid wasm');
    expect(result.exitCode).toBe(1);
  });

  it('should handle execa throwing', async () => {
    mockExeca.mockRejectedValue(new Error('ENOENT: ic-wasm not found'));

    const result = await icwasm.optimize({
      input: '/tmp/input.wasm',
      output: '/tmp/output.wasm',
    });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('ic-wasm not found');
  });
});

describe('ic-wasm shrink', () => {
  it('should call ic-wasm shrink with correct arguments', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await icwasm.shrink({
      input: '/tmp/input.wasm',
      output: '/tmp/shrunk.wasm',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'shrink', '-o', '/tmp/shrunk.wasm'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });
});

describe('ic-wasm setResource', () => {
  it('should set resource limits', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await icwasm.setResource({
      input: '/tmp/input.wasm',
      output: '/tmp/output.wasm',
      name: 'memory',
      value: '4GiB',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'resource', '-o', '/tmp/output.wasm', 'memory', '4GiB'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });
});

describe('ic-wasm metadata', () => {
  it('should list metadata', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'icp:public candid:service', stderr: '' });

    const result = await icwasm.listMetadata('/tmp/input.wasm');
    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'metadata', 'list'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should get specific metadata', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'candid data here', stderr: '' });

    const result = await icwasm.getMetadata('/tmp/input.wasm', 'candid:service');
    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'metadata', 'candid:service'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should set metadata with data string', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await icwasm.setMetadata({
      input: '/tmp/input.wasm',
      output: '/tmp/output.wasm',
      name: 'candid:service',
      data: 'service : {}',
      visibility: 'public',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'metadata', 'candid:service', '-o', '/tmp/output.wasm', '-d', 'service : {}', '-v', 'public'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should set metadata with file path', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await icwasm.setMetadata({
      input: '/tmp/input.wasm',
      output: '/tmp/output.wasm',
      name: 'candid:service',
      file: '/tmp/agent.did',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'metadata', 'candid:service', '-o', '/tmp/output.wasm', '-f', '/tmp/agent.did'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should fail setMetadata without output path', async () => {
    const result = await icwasm.setMetadata({
      input: '/tmp/input.wasm',
      name: 'test',
      data: 'value',
    });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Output path is required');
  });
});

describe('ic-wasm info', () => {
  it('should parse info output into sections', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: 'Module size: 1024\nExports: 4\nCustom sections: 2',
      stderr: '',
    });

    const result = await icwasm.info('/tmp/input.wasm');
    expect(result.raw).toContain('Module size: 1024');
    expect(result.sections).toBeDefined();
    expect(result.sections?.['Module size']).toBe('1024');
    expect(result.sections?.['Exports']).toBe('4');
  });

  it('should handle empty info output', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await icwasm.info('/tmp/input.wasm');
    expect(result.raw).toBe('');
    expect(result.sections).toBeUndefined();
  });
});

describe('ic-wasm checkEndpoints', () => {
  it('should call check-endpoints with Candid interface', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: 'All endpoints match', stderr: '' });

    const result = await icwasm.checkEndpoints({
      input: '/tmp/input.wasm',
      candidInterface: '/tmp/agent.did',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'check-endpoints', '--interface', '/tmp/agent.did'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });

  it('should report failure on endpoint mismatch', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Endpoint mismatch: missing method "execute"',
    });

    const result = await icwasm.checkEndpoints({
      input: '/tmp/input.wasm',
      candidInterface: '/tmp/agent.did',
    });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Endpoint mismatch');
  });
});

describe('ic-wasm instrument', () => {
  it('should call instrument with correct arguments', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const result = await icwasm.instrument({
      input: '/tmp/input.wasm',
      output: '/tmp/instrumented.wasm',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'ic-wasm',
      ['/tmp/input.wasm', 'instrument', '-o', '/tmp/instrumented.wasm'],
      expect.any(Object),
    );
    expect(result.success).toBe(true);
  });
});
