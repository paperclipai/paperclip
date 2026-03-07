/**
 * Agent Packager
 *
 * Main orchestrator for the agent packaging pipeline.
 * Coordinates detection, validation, and compilation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackageOptions, PackageResult, ValidationResult, ValidationError } from './types.js';
import { detectAgent, validateSourcePath } from './detector.js';
import { compileToWasm } from './compiler.js';

/**
 * Default output directory name
 */
const DEFAULT_OUTPUT_DIR = 'dist';

/**
 * Validate agent before packaging
 */
export function validateAgent(sourcePath: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  // Validate source path exists
  const pathValidation = validateSourcePath(sourcePath);
  if (!pathValidation.valid) {
    errors.push({
      code: 'INVALID_SOURCE_PATH',
      message: pathValidation.error!,
      filePath: sourcePath,
    });
    return { valid: false, errors, warnings };
  }

  // Detect agent to check for basic configuration
  const config = detectAgent(sourcePath);

  // Warn if no entry point detected
  if (!config.entryPoint) {
    warnings.push(
      `No entry point detected for agent '${config.name}'. Consider adding an index.ts or agent.ts file.`
    );
  }

  if (config.type === 'goose' && !config.entryPoint) {
    const pythonCandidates = ['goose.py', 'main.py'];
    const hasPythonEntrypoint = pythonCandidates.some((candidate) =>
      fs.existsSync(path.join(path.resolve(sourcePath), candidate))
    );
    if (hasPythonEntrypoint) {
      warnings.push(
        'Goose Python entrypoints are not supported by the bundler. Use a JS/TS entrypoint instead.'
      );
    }
  }

  // Warn if using generic type
  if (config.type === 'generic') {
    warnings.push(
      `Agent type detected as 'generic'. For better support, add a config file for clawdbot, goose, or cline.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Package an agent for deployment
 *
 * This is the main entry point for the packaging pipeline.
 *
 * @param options - Packaging options
 * @returns Package result with paths to generated files
 */
export async function packageAgent(options: PackageOptions): Promise<PackageResult> {
  const { sourcePath, outputPath, skipValidation = false } = options;

  // Validate unless skipped
  if (!skipValidation) {
    const validation = validateAgent(sourcePath);
    if (!validation.valid) {
      const errorMessages = validation.errors.map((e) => e.message).join('; ');
      throw new Error(`Validation failed: ${errorMessages}`);
    }
  }

  // Detect agent configuration
  const config = detectAgent(sourcePath);

  // Determine output directory
  const outputDir = outputPath ?? path.join(path.resolve(sourcePath), DEFAULT_OUTPUT_DIR);

  // Compile to WASM (includes ic-wasm optimization pipeline)
  const result = await compileToWasm(config, options, outputDir);

  return result;
}

/**
 * Get a summary of what will be packaged
 *
 * Useful for preview/dry-run functionality
 */
export function getPackageSummary(sourcePath: string): {
  config: ReturnType<typeof detectAgent>;
  validation: ValidationResult;
} {
  const config = detectAgent(sourcePath);
  const validation = validateAgent(sourcePath);

  return { config, validation };
}
