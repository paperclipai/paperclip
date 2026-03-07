import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = join(import.meta.dirname, '..');

describe('Project Directory Structure', () => {
  const requiredDirectories = ['cli', 'canister', 'docs', 'tests'];

  requiredDirectories.forEach((dir) => {
    it(`should have /${dir} directory`, () => {
      const dirPath = join(ROOT_DIR, dir);
      expect(existsSync(dirPath)).toBe(true);
      expect(statSync(dirPath).isDirectory()).toBe(true);
    });
  });
});
