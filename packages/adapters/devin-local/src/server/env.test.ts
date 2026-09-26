import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { devinCliEnv, devinConfigDir } from './env.js';

describe('devinCliEnv', () => {
  const original = process.env.ACP_BACKEND;

  afterEach(() => {
    if (original === undefined) delete process.env.ACP_BACKEND;
    else process.env.ACP_BACKEND = original;
  });

  it('strips an inherited ACP_BACKEND (parent Devin/ACP session leakage)', () => {
    process.env.ACP_BACKEND = 'windsurf';
    const env = devinCliEnv({ ACP_BACKEND: 'windsurf', PATH: '/usr/bin' });
    expect(env.ACP_BACKEND).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('drops undefined values and keeps everything else', () => {
    const env = devinCliEnv({ A: '1', B: undefined } as NodeJS.ProcessEnv);
    expect(env).toEqual({ A: '1' });
  });
});

describe('devinConfigDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('honors XDG_CONFIG_HOME when set', () => {
    const configHome = mkdtempSync(path.join(tmpdir(), 'devin-xdg-'));
    try {
      vi.stubEnv('XDG_CONFIG_HOME', configHome);
      expect(devinConfigDir()).toBe(path.join(configHome, 'devin'));
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it('falls back to ~/.config/devin when XDG_CONFIG_HOME is unset', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    expect(devinConfigDir()).toBe(path.join(homedir(), '.config', 'devin'));
  });
});
