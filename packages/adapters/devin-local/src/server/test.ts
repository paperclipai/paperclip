import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from '@paperclipai/adapter-utils';
import { asString } from '@paperclipai/adapter-utils/server-utils';
import { devinCliEnv } from './env.js';
import { listDevinModels } from './models.js';

const execFileAsync = promisify(execFile);

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = asString(config.command, 'devin');

  // 1. devin binary resolvable + version
  try {
    const version = (
      await execFileAsync(command, ['version'], {
        encoding: 'utf8',
        timeout: 15_000,
        env: devinCliEnv(),
      })
    ).stdout
      .trim()
      .split('\n')[0];
    checks.push({
      level: 'info',
      message: `Devin CLI resolved: ${version}`,
      code: 'devin_command_resolvable',
    });
  } catch {
    checks.push({
      level: 'error',
      message: `Devin CLI not found or not runnable: "${command}"`,
      hint: 'Install/authenticate the Devin CLI (https://docs.devin.ai/cli) and ensure it is on PATH.',
      code: 'devin_command_missing',
    });
  }

  // 2. cwd valid (absolute + exists)
  const cwd = asString(config.cwd, homedir());
  if (!path.isAbsolute(cwd)) {
    checks.push({
      level: 'error',
      message: `Working directory must be absolute: "${cwd}"`,
      code: 'invalid_cwd',
    });
  } else if (!existsSync(cwd)) {
    checks.push({
      level: 'warn',
      message: `Working directory does not exist yet: ${cwd}`,
      code: 'cwd_missing',
    });
  } else {
    checks.push({
      level: 'info',
      message: `Working directory valid: ${cwd}`,
      code: 'cwd_valid',
    });
  }

  // 3. ~/.config/devin present (devin-specific config)
  const devinCfg = path.join(homedir(), '.config', 'devin');
  checks.push(
    existsSync(devinCfg)
      ? {
          level: 'info',
          message: `Devin config present: ${devinCfg}`,
          code: 'devin_config_present',
        }
      : {
          level: 'warn',
          message: `Devin config not found: ${devinCfg}`,
          hint: 'Run `devin setup` to configure.',
          code: 'devin_config_missing',
        },
  );

  // 4. AGENTS.md in cwd (portable instruction channel)
  if (path.isAbsolute(cwd) && existsSync(cwd)) {
    const agentsMd = path.join(cwd, 'AGENTS.md');
    checks.push(
      existsSync(agentsMd)
        ? {
            level: 'info',
            message: `AGENTS.md found in working directory: ${agentsMd}`,
            code: 'agents_md_present',
          }
        : {
            level: 'warn',
            message: `No AGENTS.md in working directory: ${cwd}`,
            hint: 'Create AGENTS.md in cwd for project-specific Devin instructions.',
            code: 'agents_md_missing',
          },
    );
  }

  // 5. Verify `devin models list` works and we can parse the catalog.
  try {
    const models = await listDevinModels(command);
    checks.push({
      level: 'info',
      message: `Discovered ${models.length} Devin models`,
      code: 'devin_models_list_ok',
    });
  } catch (e) {
    checks.push({
      level: 'warn',
      message: `Could not refresh Devin model catalog: ${String(e).slice(0, 160)}`,
      hint: 'Run `devin models list --format json` to diagnose authentication or connectivity.',
      code: 'devin_models_list_failed',
    });
  }

  // 6. Verify the CLI advertises the print and export flags.
  try {
    const { stdout } = await execFileAsync(command, ['--help'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: devinCliEnv(),
    });
    const help = stdout.toLowerCase();
    if (help.includes('--print') && help.includes('--export')) {
      checks.push({
        level: 'info',
        message: 'Devin CLI supports print mode and ATIF export.',
        code: 'devin_print_export_supported',
      });
    } else {
      checks.push({
        level: 'warn',
        message: 'Devin CLI help did not mention --print or --export.',
        code: 'devin_print_export_uncertain',
      });
    }
  } catch {
    checks.push({
      level: 'warn',
      message: 'Could not read Devin CLI help.',
      code: 'devin_help_failed',
    });
  }

  const status = checks.some((c) => c.level === 'error')
    ? 'fail'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'pass';

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
