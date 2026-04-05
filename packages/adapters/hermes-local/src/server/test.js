
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { HERMES_DEFAULT_COMMAND, VALID_PROVIDERS } from '../shared/constants.js';
import { asRecord, asTrimmedString, firstNonEmptyLine, resolveHermesHome } from '../shared/utils.js';
import { detectModel, detectConfiguredHermesHomePaths, resolveProvider } from './detect-model.js';
import { detectCopilotCommand, detectClaudeCodeCredentialHint, readHermesAuthFile } from './hermes-auth.js';
import { detectAvailableProviders, extractResolvedConfigEnv, readHermesEnvFile } from './hermes-env.js';
import { listHermesModels } from './list-models.js';

const execFileAsync = promisify(execFile);

/**
 * Build a Paperclip-compatible environment test report.
 *
 * @param {{adapterType?: string, config?: Record<string, unknown>}} ctx
 */
export async function testEnvironment(ctx = {}) {
  const config = asRecord(ctx.config);
  const checks = [];
  const command = asTrimmedString(config.hermesCommand) || asTrimmedString(config.command) || HERMES_DEFAULT_COMMAND;

  const cliCheck = await checkCliInstalled(command);
  if (cliCheck) checks.push(cliCheck);
  if (cliCheck?.level === 'error') {
    return finalize(ctx, checks);
  }

  const versionCheck = await checkCliVersion(command);
  if (versionCheck) checks.push(versionCheck);

  const pythonCheck = await checkPython();
  if (pythonCheck) checks.push(pythonCheck);

  const paths = detectConfiguredHermesHomePaths(config);
  checks.push({
    level: 'info',
    code: 'hermes_home',
    message: `Hermes home: ${paths.hermesHome}`,
  });

  const envCheck = await checkCredentials(config, command);
  if (envCheck) checks.push(envCheck);

  const modelCheck = await checkModel(config);
  if (modelCheck) checks.push(modelCheck);

  const providerCheck = await checkProviderConsistency(config);
  if (providerCheck) checks.push(providerCheck);

  const copilotCheck = checkCopilotCommandHint();
  if (copilotCheck) checks.push(copilotCheck);

  return finalize(ctx, checks);
}

function finalize(ctx, checks) {
  const hasErrors = checks.some((item) => item.level === 'error');
  const hasWarnings = checks.some((item) => item.level === 'warn');
  return {
    adapterType: ctx.adapterType || 'hermes_local',
    status: hasErrors ? 'fail' : hasWarnings ? 'warn' : 'pass',
    checks,
    testedAt: new Date().toISOString(),
  };
}

export async function checkCliInstalled(command) {
  try {
    await execFileAsync(command, ['--version'], { timeout: 10_000 });
    return null;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        level: 'error',
        code: 'hermes_cli_missing',
        message: `Hermes CLI "${command}" was not found in PATH`,
        hint: 'Install Hermes Agent and/or point hermesCommand at the correct binary or wrapper script.',
      };
    }
    return null;
  }
}

export async function checkCliVersion(command) {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], { timeout: 10_000 });
    const version = firstNonEmptyLine(stdout) || firstNonEmptyLine(stderr);
    return version
      ? { level: 'info', code: 'hermes_cli_version', message: `Hermes CLI version: ${version}` }
      : { level: 'warn', code: 'hermes_cli_version_unknown', message: 'Could not determine Hermes CLI version' };
  } catch {
    return { level: 'warn', code: 'hermes_cli_version_failed', message: 'Failed to read Hermes CLI version' };
  }
}

export async function checkPython() {
  try {
    const { stdout, stderr } = await execFileAsync('python3', ['--version'], { timeout: 5_000 });
    const text = firstNonEmptyLine(stdout) || firstNonEmptyLine(stderr);
    const match = text.match(/(\d+)\.(\d+)/);
    if (match) {
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major < 3 || (major === 3 && minor < 10)) {
        return {
          level: 'error',
          code: 'python_too_old',
          message: `Python ${text} found — Hermes requires Python 3.10+`,
        };
      }
    }
    return null;
  } catch {
    return {
      level: 'warn',
      code: 'python_missing',
      message: 'python3 was not found in PATH',
      hint: 'Hermes itself requires Python 3.10+.',
    };
  }
}

export async function checkCredentials(config, command) {
  const configEnv = extractResolvedConfigEnv(config);
  const fileEnv = await readHermesEnvFile({ config });
  const processEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string' && value)
  );
  const providers = detectAvailableProviders(configEnv, fileEnv, processEnv);

  const auth = readHermesAuthFile({ config });
  const activeProvider = asTrimmedString(auth.active_provider);
  if (activeProvider && !providers.includes(activeProvider)) providers.push(activeProvider);

  const claudeHint = detectClaudeCodeCredentialHint();
  if (claudeHint.found && !providers.includes('anthropic')) providers.push('anthropic');

  if (!providers.length) {
    return {
      level: 'warn',
      code: 'provider_credentials_missing',
      message: 'No Hermes provider credentials were detected in adapter config, ~/.hermes/.env, or known auth stores',
      hint: 'Configure credentials in the agent env, ~/.hermes/.env, or Hermes login flows before using the adapter.',
    };
  }

  return {
    level: 'info',
    code: 'provider_credentials_found',
    message: `Detected provider credentials: ${providers.join(', ')}`,
  };
}

export async function checkModel(config) {
  const explicitModel = asTrimmedString(config.model);
  const configPath = path.join(resolveHermesHome(config), 'config.yaml');
  const detected = await detectModel(configPath);
  const listed = await listHermesModels({ configPath });

  if (!explicitModel && detected?.model) {
    return {
      level: 'info',
      code: 'default_model_detected',
      message: `Hermes default model: ${detected.model}${detected.provider ? ` (${detected.provider})` : ''}`,
    };
  }

  if (!explicitModel) {
    return {
      level: 'warn',
      code: 'model_not_configured',
      message: 'No explicit model is configured in Paperclip and no Hermes default model was detected',
      hint: 'Set model.default in ~/.hermes/config.yaml or choose a model explicitly in Paperclip.',
    };
  }

  if (listed.some((entry) => entry.id === explicitModel)) {
    return {
      level: 'info',
      code: 'model_available',
      message: `Configured model is available: ${explicitModel}`,
    };
  }

  return {
    level: 'warn',
    code: 'model_not_listed',
    message: `Configured model is not listed in Hermes config discovery: ${explicitModel}`,
    hint: 'This may still work if the model is valid, but it usually means Paperclip and Hermes are pointed at different model config.',
  };
}

export async function checkProviderConsistency(config) {
  const explicitModel = asTrimmedString(config.model);
  if (!explicitModel) return null;
  const explicitProvider = asTrimmedString(config.provider);
  const configPath = path.join(resolveHermesHome(config), 'config.yaml');
  const detected = await detectModel(configPath);
  const resolved = resolveProvider({
    explicitProvider,
    detectedProvider: detected?.provider,
    detectedModel: detected?.model,
    model: explicitModel,
  });

  if (explicitProvider && detected?.provider && explicitProvider !== detected.provider) {
    return {
      level: 'warn',
      code: 'provider_mismatch',
      message: `Paperclip provider "${explicitProvider}" differs from Hermes config provider "${detected.provider}"`,
      hint: 'That is allowed, but make sure you did it on purpose.',
    };
  }

  if (!explicitProvider && resolved.resolvedFrom !== 'auto') {
    return {
      level: 'info',
      code: 'provider_auto_resolved',
      message: `Provider resolved as "${resolved.provider}" from ${resolved.resolvedFrom}`,
    };
  }

  return {
    level: 'warn',
    code: 'provider_auto_only',
    message: `Provider will fall back to Hermes auto-detection for model "${explicitModel}"`,
    hint: 'Set provider explicitly only when you need a forced route.',
  };
}

export function checkCopilotCommandHint() {
  const found = detectCopilotCommand();
  return found.found
    ? { level: 'info', code: 'copilot_cli_found', message: `Copilot command found at ${found.path}` }
    : null;
}
