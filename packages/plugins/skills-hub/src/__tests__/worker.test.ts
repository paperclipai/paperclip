import { describe, it, expect } from 'vitest';
import manifest from '../manifest';

describe('Skills Hub Plugin', () => {
  describe('manifest validation', () => {
    it('should have valid manifest structure', () => {
      expect(manifest.id).toBe('skills.hub');
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.tools).toBeDefined();
      expect(Array.isArray(manifest.tools)).toBe(true);
    });

    it('should declare all 12 skills hub tools', () => {
      const expectedTools = [
        'search_skills',
        'get_skill',
        'get_trending',
        'get_top_rated',
        'get_rising',
        'get_categories',
        'get_masters',
        'get_stats',
        'submit_skill',
        'scan_security',
        'get_workflows',
        'get_landing',
      ];

      const declaredTools = manifest.tools!.map((t) => t.name);

      expectedTools.forEach((tool) => {
        expect(declaredTools).toContain(tool);
      });

      expect(declaredTools).toHaveLength(12);
    });

    it('should have unique tool names', () => {
      const names = manifest.tools!.map((t) => t.name);
      const unique = new Set(names);
      expect(names.length).toBe(unique.size);
    });

    it('should have valid tool schemas', () => {
      manifest.tools!.forEach((tool) => {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.parametersSchema).toBeDefined();
        expect(typeof tool.parametersSchema).toBe('object');
      });
    });
  });

  describe('search_skills tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'search_skills');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have optional query property', () => {
      expect(tool!.parametersSchema.properties.query).toBeDefined();
      expect(tool!.parametersSchema.properties.query.type).toBe('string');
    });

    it('should have optional category property', () => {
      expect(tool!.parametersSchema.properties.category).toBeDefined();
      expect(tool!.parametersSchema.properties.category.type).toBe('string');
    });

    it('should have optional platform property', () => {
      expect(tool!.parametersSchema.properties.platform).toBeDefined();
      expect(tool!.parametersSchema.properties.platform.type).toBe('string');
    });

    it('should have optional limit property', () => {
      expect(tool!.parametersSchema.properties.limit).toBeDefined();
      expect(tool!.parametersSchema.properties.limit.type).toBe('number');
    });
  });

  describe('get_skill tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_skill');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required skill_id field', () => {
      expect(tool!.parametersSchema.required).toContain('skill_id');
    });

    it('should have skill_id property as number', () => {
      expect(tool!.parametersSchema.properties.skill_id).toBeDefined();
      expect(tool!.parametersSchema.properties.skill_id.type).toBe('number');
    });
  });

  describe('get_trending tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_trending');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have optional days property', () => {
      expect(tool!.parametersSchema.properties.days).toBeDefined();
      expect(tool!.parametersSchema.properties.days.type).toBe('number');
    });

    it('should have optional limit property', () => {
      expect(tool!.parametersSchema.properties.limit).toBeDefined();
      expect(tool!.parametersSchema.properties.limit.type).toBe('number');
    });
  });

  describe('get_top_rated tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_top_rated');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have optional limit property', () => {
      expect(tool!.parametersSchema.properties.limit).toBeDefined();
      expect(tool!.parametersSchema.properties.limit.type).toBe('number');
    });
  });

  describe('get_rising tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_rising');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have optional limit property', () => {
      expect(tool!.parametersSchema.properties.limit).toBeDefined();
      expect(tool!.parametersSchema.properties.limit.type).toBe('number');
    });
  });

  describe('get_categories tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_categories');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have no required fields', () => {
      expect(tool!.parametersSchema.required).toBeUndefined();
    });
  });

  describe('get_masters tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_masters');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have no required fields', () => {
      expect(tool!.parametersSchema.required).toBeUndefined();
    });
  });

  describe('get_stats tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_stats');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have no required fields', () => {
      expect(tool!.parametersSchema.required).toBeUndefined();
    });
  });

  describe('submit_skill tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'submit_skill');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required repo_url field', () => {
      expect(tool!.parametersSchema.required).toContain('repo_url');
    });

    it('should have repo_url property as string', () => {
      expect(tool!.parametersSchema.properties.repo_url).toBeDefined();
      expect(tool!.parametersSchema.properties.repo_url.type).toBe('string');
    });
  });

  describe('scan_security tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'scan_security');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required repo_url field', () => {
      expect(tool!.parametersSchema.required).toContain('repo_url');
    });

    it('should have repo_url property as string', () => {
      expect(tool!.parametersSchema.properties.repo_url).toBeDefined();
      expect(tool!.parametersSchema.properties.repo_url.type).toBe('string');
    });
  });

  describe('get_workflows tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_workflows');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have no required fields', () => {
      expect(tool!.parametersSchema.required).toBeUndefined();
    });
  });

  describe('get_landing tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'get_landing');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have no required fields', () => {
      expect(tool!.parametersSchema.required).toBeUndefined();
    });
  });

  describe('Tool description quality', () => {
    it('should have descriptive descriptions for all tools', () => {
      manifest.tools!.forEach((tool) => {
        expect(tool.description.length).toBeGreaterThan(10);
        expect(tool.description).not.toMatch(/^(foo|bar|test|placeholder)/i);
      });
    });

    it('should have consistent naming convention', () => {
      manifest.tools!.forEach((tool) => {
        expect(tool.name).toMatch(/^[a-z_]+$/);
        expect(tool.name).not.toMatch(/^[A-Z]/);
        expect(tool.name).not.toMatch(/-/);
      });
    });
  });
});
