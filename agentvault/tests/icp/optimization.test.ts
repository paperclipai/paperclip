/**
 * Tests for optimization pipeline
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock the tool detector and ic-wasm wrapper
vi.mock('../../src/icp/tool-detector.js', () => ({
  detectTool: vi.fn(),
}));

vi.mock('../../src/icp/icwasm.js', () => ({
  shrink: vi.fn(),
  optimize: vi.fn(),
  setResource: vi.fn(),
  setMetadata: vi.fn(),
  checkEndpoints: vi.fn(),
}));

import { runOptimizationPipeline } from '../../src/icp/optimization.js';
import { detectTool } from '../../src/icp/tool-detector.js';
import * as icwasm from '../../src/icp/icwasm.js';

const mockDetectTool = detectTool as unknown as ReturnType<typeof vi.fn>;
const mockShrink = icwasm.shrink as unknown as ReturnType<typeof vi.fn>;
const mockOptimize = icwasm.optimize as unknown as ReturnType<typeof vi.fn>;
const mockSetResource = icwasm.setResource as unknown as ReturnType<typeof vi.fn>;
const mockCheckEndpoints = icwasm.checkEndpoints as unknown as ReturnType<typeof vi.fn>;

let tempDir: string;
let inputPath: string;
let outputPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-test-'));
  inputPath = path.join(tempDir, 'input.wasm');
  outputPath = path.join(tempDir, 'output.wasm');

  // Create a fake WASM file
  fs.writeFileSync(inputPath, Buffer.alloc(1024, 0xff));
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('runOptimizationPipeline', () => {
  it('should skip optimization when ic-wasm is not available', async () => {
    mockDetectTool.mockResolvedValue({ name: 'ic-wasm', available: false });

    const result = await runOptimizationPipeline({
      input: inputPath,
      output: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('ic-wasm not found')]));
    expect(result.reductionPercent).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('should run shrink and optimize when ic-wasm is available', async () => {
    mockDetectTool.mockResolvedValue({ name: 'ic-wasm', available: true, version: '0.9.11' });

    // Mock shrink to write a smaller file
    mockShrink.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(800, 0xaa));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });

    // Mock optimize to write an even smaller file
    mockOptimize.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(600, 0xbb));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await runOptimizationPipeline({
      input: inputPath,
      output: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.originalSize).toBe(1024);
    expect(result.finalSize).toBe(600);
    expect(result.reductionPercent).toBeGreaterThan(0);
    expect(result.steps.length).toBe(2); // shrink + optimize
    expect(mockShrink).toHaveBeenCalled();
    expect(mockOptimize).toHaveBeenCalled();
  });

  it('should skip shrink when disabled', async () => {
    mockDetectTool.mockResolvedValue({ name: 'ic-wasm', available: true });

    mockOptimize.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(700, 0xcc));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await runOptimizationPipeline({
      input: inputPath,
      output: outputPath,
      shrink: false,
    });

    expect(mockShrink).not.toHaveBeenCalled();
    expect(mockOptimize).toHaveBeenCalled();
    expect(result.steps.length).toBe(1);
  });

  it('should skip optimize when disabled', async () => {
    mockDetectTool.mockResolvedValue({ name: 'ic-wasm', available: true });

    mockShrink.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(900, 0xdd));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await runOptimizationPipeline({
      input: inputPath,
      output: outputPath,
      optimize: false,
    });

    expect(mockShrink).toHaveBeenCalled();
    expect(mockOptimize).not.toHaveBeenCalled();
    expect(result.steps.length).toBe(1);
  });

  it('should set resource limits', async () => {
    mockDetectTool.mockResolvedValue({ name: 'ic-wasm', available: true });

    mockShrink.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(900, 0xee));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });
    mockOptimize.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(800, 0xff));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });
    mockSetResource.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(810, 0x11));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await runOptimizationPipeline({
      input: inputPath,
      output: outputPath,
      resourceLimits: { memory: '4GiB' },
    });

    expect(mockSetResource).toHaveBeenCalled();
    expect(result.steps.some(s => s.step.includes('resource'))).toBe(true);
  });

  it('should validate against Candid interface', async () => {
    mockDetectTool.mockResolvedValue({ name: 'ic-wasm', available: true });

    mockShrink.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(900));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });
    mockOptimize.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(800));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });
    mockCheckEndpoints.mockResolvedValue({
      success: true, stdout: 'All endpoints match', stderr: '', exitCode: 0,
    });

    const result = await runOptimizationPipeline({
      input: inputPath,
      output: outputPath,
      candidInterface: '/tmp/agent.did',
    });

    expect(result.validationPassed).toBe(true);
    expect(mockCheckEndpoints).toHaveBeenCalled();
  });

  it('should report validation failure', async () => {
    mockDetectTool.mockResolvedValue({ name: 'ic-wasm', available: true });

    mockShrink.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(900));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });
    mockOptimize.mockImplementation(async (opts: any) => {
      fs.writeFileSync(opts.output, Buffer.alloc(800));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });
    mockCheckEndpoints.mockResolvedValue({
      success: false, stdout: '', stderr: 'Endpoint mismatch', exitCode: 1,
    });

    const result = await runOptimizationPipeline({
      input: inputPath,
      output: outputPath,
      candidInterface: '/tmp/agent.did',
    });

    expect(result.validationPassed).toBe(false);
    expect(result.success).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Candid validation failed')]));
  });

  it('should handle missing input file', async () => {
    const result = await runOptimizationPipeline({
      input: '/nonexistent/file.wasm',
      output: outputPath,
    });

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('not found')]));
  });

  it('should continue on step failure and report warnings', async () => {
    mockDetectTool.mockResolvedValue({ name: 'ic-wasm', available: true });

    // Shrink fails
    mockShrink.mockResolvedValue({
      success: false, stdout: '', stderr: 'Shrink error', exitCode: 1,
    });

    // Optimize succeeds
    mockOptimize.mockImplementation(async (opts: any) => {
      // Should use original input since shrink failed
      fs.writeFileSync(opts.output, Buffer.alloc(700));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await runOptimizationPipeline({
      input: inputPath,
      output: outputPath,
    });

    // Pipeline partially failed
    expect(result.success).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.steps[0]?.success).toBe(false);
    expect(result.steps[1]?.success).toBe(true);
  });
});
