import { describe, it, expect } from 'vitest';
import manifest from '../manifest';

describe('Playwright MCP Plugin', () => {
  describe('manifest validation', () => {
    it('should have valid manifest structure', () => {
      expect(manifest.id).toBe('playwright.mcp');
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.tools).toBeDefined();
      expect(Array.isArray(manifest.tools)).toBe(true);
    });

    it('should declare all 10 browser automation tools', () => {
      const expectedTools = [
        'browser_navigate',
        'browser_click',
        'browser_fill',
        'browser_screenshot',
        'browser_extract',
        'browser_evaluate',
        'browser_wait_for',
        'browser_get_url',
        'browser_get_title',
        'browser_close',
      ];

      const declaredTools = manifest.tools!.map((t) => t.name);

      expectedTools.forEach((tool) => {
        expect(declaredTools).toContain(tool);
      });

      expect(declaredTools).toHaveLength(10);
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

  describe('browser_navigate tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'browser_navigate');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should require url parameter', () => {
      expect(tool?.parametersSchema.required).toContain('url');
    });

    it('should have waitUntil parameter with correct enum values', () => {
      const waitUntil = (tool?.parametersSchema.properties as any)?.waitUntil;
      expect(waitUntil).toBeDefined();
      expect(waitUntil.enum).toEqual(['load', 'domcontentloaded', 'networkidle']);
    });
  });

  describe('browser_click tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'browser_click');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should require selector parameter', () => {
      expect(tool?.parametersSchema.required).toContain('selector');
    });

    it('should have waitForNavigation parameter', () => {
      const waitForNav = (tool?.parametersSchema.properties as any)?.waitForNavigation;
      expect(waitForNav).toBeDefined();
      expect(waitForNav.type).toBe('boolean');
    });
  });

  describe('browser_fill tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'browser_fill');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should require selector and value parameters', () => {
      expect(tool?.parametersSchema.required).toContain('selector');
      expect(tool?.parametersSchema.required).toContain('value');
    });

    it('should have clear parameter with default', () => {
      const clear = (tool?.parametersSchema.properties as any)?.clear;
      expect(clear).toBeDefined();
      expect(clear.type).toBe('boolean');
      expect(clear.default).toBe(true);
    });
  });

  describe('browser_extract tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'browser_extract');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should require selectors parameter', () => {
      expect(tool?.parametersSchema.required).toContain('selectors');
    });

    it('should have selectors as object type', () => {
      const selectors = (tool?.parametersSchema.properties as any)?.selectors;
      expect(selectors).toBeDefined();
      expect(selectors.type).toBe('object');
    });
  });

  describe('browser_wait_for tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'browser_wait_for');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should require selector parameter', () => {
      expect(tool?.parametersSchema.required).toContain('selector');
    });

    it('should have state parameter with correct enum values', () => {
      const state = (tool?.parametersSchema.properties as any)?.state;
      expect(state).toBeDefined();
      expect(state.enum).toEqual(['attached', 'detached', 'visible', 'hidden']);
      expect(state.default).toBe('visible');
    });

    it('should have timeout parameter with default', () => {
      const timeout = (tool?.parametersSchema.properties as any)?.timeout;
      expect(timeout).toBeDefined();
      expect(timeout.type).toBe('number');
      expect(timeout.default).toBe(30000);
    });
  });

  describe('browser_screenshot tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'browser_screenshot');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have optional selector parameter', () => {
      const selector = (tool?.parametersSchema.properties as any)?.selector;
      expect(selector).toBeDefined();
      expect(selector.type).toBe('string');
    });

    it('should have fullPage parameter with default', () => {
      const fullPage = (tool?.parametersSchema.properties as any)?.fullPage;
      expect(fullPage).toBeDefined();
      expect(fullPage.type).toBe('boolean');
      expect(fullPage.default).toBe(false);
    });
  });

  describe('browser_evaluate tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'browser_evaluate');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should require script parameter', () => {
      expect(tool?.parametersSchema.required).toContain('script');
    });

    it('should have script as string type', () => {
      const script = (tool?.parametersSchema.properties as any)?.script;
      expect(script).toBeDefined();
      expect(script.type).toBe('string');
    });
  });

  describe('tool documentation quality', () => {
    it('should have descriptions longer than 20 characters', () => {
      manifest.tools!.forEach((tool) => {
        expect(tool.description.length).toBeGreaterThan(20);
      });
    });

    it('should have displayName for all tools', () => {
      manifest.tools!.forEach((tool) => {
        expect(tool.displayName).toBeDefined();
        expect(tool.displayName!.length).toBeGreaterThan(0);
      });
    });
  });
});
