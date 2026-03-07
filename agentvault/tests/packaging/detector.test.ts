import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { detectAgent, detectAgentType, validateSourcePath } from '../../src/packaging/detector.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('detector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateSourcePath', () => {
    it('should return valid for existing directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats);

      const result = validateSourcePath('/some/path');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return invalid for non-existent path', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = validateSourcePath('/nonexistent/path');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('should return invalid for file path', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);

      const result = validateSourcePath('/some/file.txt');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a directory');
    });
  });

  describe('detectAgentType', () => {
    it('should detect clawdbot agent from config file', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('clawdbot.json');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, isDirectory: () => false } as fs.Stats);

      const result = detectAgentType('/agent/path');
      expect(result).toBe('clawdbot');
    });

    it('should detect goose agent from config file', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('goose.yaml');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, isDirectory: () => false } as fs.Stats);

      const result = detectAgentType('/agent/path');
      expect(result).toBe('goose');
    });

    it('should detect cline agent from config file', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('cline.json');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, isDirectory: () => false } as fs.Stats);

      const result = detectAgentType('/agent/path');
      expect(result).toBe('cline');
    });

    it('should detect clawdbot from .clawdbot directory', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('.clawdbot');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => false, isDirectory: () => true } as fs.Stats);

      const result = detectAgentType('/agent/path');
      expect(result).toBe('clawdbot');
    });

    it('should return generic when no specific agent detected', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = detectAgentType('/agent/path');
      expect(result).toBe('generic');
    });
  });

  describe('detectAgent', () => {
    it('should detect agent configuration', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = String(p);
        return pathStr.endsWith('clawdbot.json') || pathStr.endsWith('index.ts');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, isDirectory: () => false } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ name: 'my-clawdbot', version: '2.0.0' })
      );

      const result = detectAgent('/path/to/my-agent');
      expect(result.name).toBe('my-clawdbot');
      expect(result.type).toBe('clawdbot');
      expect(result.version).toBe('2.0.0');
      expect(result.entryPoint).toBe('index.ts');
    });

    it('should use directory name as fallback for agent name', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = detectAgent('/path/to/My Custom Agent');
      expect(result.name).toBe('my-custom-agent');
      expect(result.type).toBe('generic');
    });

    it('should handle missing entry point', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = detectAgent('/path/to/agent');
      expect(result.entryPoint).toBeUndefined();
    });

    it('should handle malformed config file', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('clawdbot.json');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, isDirectory: () => false } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }');

      const result = detectAgent('/path/to/agent');
      // Should fall back to directory name
      expect(result.name).toBe('agent');
    });
  });
});
