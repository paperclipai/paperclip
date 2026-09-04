import { afterEach, describe, expect, it } from 'vitest';
import { devinCliEnv } from './env.js';

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
