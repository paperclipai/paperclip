import { describe, expect, it } from 'vitest';
import { buildDevinLocalConfig } from './build-config.js';
import type { CreateConfigValues } from '@paperclipai/adapter-utils';

function makeValues(
  overrides: Partial<CreateConfigValues> = {},
  schemaValues: Record<string, unknown> = {},
): CreateConfigValues {
  return {
    adapterType: 'devin_local',
    cwd: '',
    instructionsFilePath: '',
    promptTemplate: '',
    model: '',
    thinkingEffort: '',
    chrome: false,
    command: '',
    extraArgs: '',
    envVars: '',
    envBindings: {},
    url: '',
    bootstrapPrompt: '',
    payloadTemplateJson: '',
    workspaceStrategyType: 'project_primary',
    workspaceBaseRef: '',
    workspaceBranchTemplate: '',
    worktreeParentDir: '',
    runtimeServicesJson: '',
    heartbeatEnabled: false,
    intervalSec: 300,
    adapterSchemaValues: schemaValues,
    ...overrides,
  } as CreateConfigValues;
}

describe('buildDevinLocalConfig', () => {
  // The create form's segmented control shows `auto` for an untouched
  // permission field; the builder must persist what the form displays.
  it('saves auto for an untouched permission-mode control', () => {
    expect(buildDevinLocalConfig(makeValues())).toMatchObject({
      permissionMode: 'auto',
    });
  });

  it('persists every offered permission mode exactly as picked', () => {
    for (const mode of [
      'auto',
      'normal',
      'accept-edits',
      'smart',
      'dangerous',
      'autonomous',
    ]) {
      expect(
        buildDevinLocalConfig(makeValues({}, { permissionMode: mode })),
      ).toMatchObject({ permissionMode: mode });
    }
  });

  it('fails closed to auto on an unrecognized mode, never to a more permissive one', () => {
    expect(
      buildDevinLocalConfig(
        makeValues({}, { permissionMode: 'allow-everything' }),
      ),
    ).toMatchObject({ permissionMode: 'auto' });
  });

  it('splits extraArgs on commas or whitespace', () => {
    expect(
      buildDevinLocalConfig(
        makeValues({}, { extraArgs: '--verbose, --timeout 30' }),
      ),
    ).toMatchObject({ extraArgs: ['--verbose', '--timeout', '30'] });
  });

  it('omits default/empty values and persists explicit ones', () => {
    const bare = buildDevinLocalConfig(makeValues());
    expect(bare).not.toHaveProperty('fastMode');
    expect(bare).not.toHaveProperty('sandbox');
    expect(bare).not.toHaveProperty('contextSize');
    expect(bare).not.toHaveProperty('thinkingEffort');
    expect(bare).toMatchObject({ timeoutSec: 1800, graceSec: 15 });

    const full = buildDevinLocalConfig(
      makeValues(
        { cwd: '/tmp/work', model: 'glm-5-3', command: '/opt/devin' },
        {
          fastMode: true,
          sandbox: true,
          contextSize: '1m',
          thinkingEffort: 'high',
          exportPath: '/tmp/x.atif',
        },
      ),
    );
    expect(full).toMatchObject({
      cwd: '/tmp/work',
      model: 'glm-5-3',
      command: '/opt/devin',
      fastMode: true,
      sandbox: true,
      contextSize: '1m',
      thinkingEffort: 'high',
      exportPath: '/tmp/x.atif',
    });
  });

  it('rejects a negative timeout and non-finite grace with platform defaults', () => {
    const config = buildDevinLocalConfig(
      makeValues({ timeoutSec: -5 }, { graceSec: Number.NaN }),
    );
    expect(config).toMatchObject({ timeoutSec: 1800, graceSec: 15 });
  });
});
