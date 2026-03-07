import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = join(import.meta.dirname, '..');

describe('Project Files', () => {
  describe('LICENSE', () => {
    const licensePath = join(ROOT_DIR, 'LICENSE');

    it('should exist', () => {
      expect(existsSync(licensePath)).toBe(true);
    });

    it('should be an MIT license', () => {
      const content = readFileSync(licensePath, 'utf-8');
      expect(content).toContain('MIT License');
    });

    it('should include copyright notice', () => {
      const content = readFileSync(licensePath, 'utf-8');
      expect(content).toContain('Copyright');
      expect(content).toContain('AgentVault Contributors');
    });

    it('should include standard MIT license terms', () => {
      const content = readFileSync(licensePath, 'utf-8');
      expect(content).toContain('Permission is hereby granted, free of charge');
      expect(content).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    });
  });

  describe('README.md', () => {
    const readmePath = join(ROOT_DIR, 'README.md');

    it('should exist', () => {
      expect(existsSync(readmePath)).toBe(true);
    });

    it('should have project title', () => {
      const content = readFileSync(readmePath, 'utf-8');
      expect(content).toContain('# AgentVault');
    });

    it('should have current status section', () => {
      const content = readFileSync(readmePath, 'utf-8');
      expect(content).toContain('## Features');
    });

    it('should have repository layout section', () => {
      const content = readFileSync(readmePath, 'utf-8');
      expect(content).toContain('## Project Structure');
    });

    it('should have quick start section', () => {
      const content = readFileSync(readmePath, 'utf-8');
      expect(content).toContain('## Quick Start');
    });

    it('should have license section', () => {
      const content = readFileSync(readmePath, 'utf-8');
      expect(content).toContain('## License');
      expect(content).toContain('MIT');
    });

    it('should reference the LICENSE file', () => {
      const content = readFileSync(readmePath, 'utf-8');
      expect(content).toContain('./LICENSE');
    });
  });
});
