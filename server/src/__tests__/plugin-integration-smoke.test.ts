/**
 * Plugin Integration Smoke Tests
 * 
 * Validates structure and completeness of plugin manifests
 * for all three official Paperclip plugins.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginsDir = join(__dirname, '../../../packages/plugins');

describe('Plugin Integration Smoke Tests', () => {
  const plugins = [
    {
      name: 'playwright-mcp',
      id: 'playwright.mcp',
      displayName: 'Playwright MCP',
      expectedTools: 10,
    },
    {
      name: 'ruflo-bridge',
      id: 'ruflo.bridge',
      displayName: 'Ruflo MCP Bridge',
      expectedTools: 9,
    },
    {
      name: 'skills-hub',
      id: 'skills.hub',
      displayName: 'Agent Skills Hub',
      expectedTools: 10,
    },
  ];

  describe('Manifest File Existence', () => {
    plugins.forEach(plugin => {
      it(`${plugin.name} has manifest.ts`, () => {
        const manifestPath = join(pluginsDir, plugin.name, 'src', 'manifest.ts');
        expect(existsSync(manifestPath)).toBe(true);
      });

      it(`${plugin.name} has dist/worker.js (built)`, () => {
        const workerPath = join(pluginsDir, plugin.name, 'dist', 'worker.js');
        expect(existsSync(workerPath)).toBe(true);
      });

      it(`${plugin.name} has README.md`, () => {
        const readmePath = join(pluginsDir, plugin.name, 'README.md');
        expect(existsSync(readmePath)).toBe(true);
      });
    });
  });

  describe('Manifest Structure Validation', () => {
    plugins.forEach(plugin => {
      it(`${plugin.name} manifest has valid TypeScript structure`, () => {
        const manifestPath = join(pluginsDir, plugin.name, 'src', 'manifest.ts');
        const content = readFileSync(manifestPath, 'utf-8');
        
        // Check for required manifest fields
        expect(content).toContain('apiVersion: 1');
        expect(content).toContain(`id: "${plugin.id}"`);
        expect(content).toContain(`displayName: "${plugin.displayName}"`);
        expect(content).toContain('tools: [');
        expect(content).toContain('entrypoints:');
        expect(content).toContain('worker:');
      });

      it(`${plugin.name} manifest declares required capabilities`, () => {
        const manifestPath = join(pluginsDir, plugin.name, 'src', 'manifest.ts');
        const content = readFileSync(manifestPath, 'utf-8');
        
        expect(content).toContain('"agent.tools.register"');
      });
    });
  });

  describe('Tool Schema Validation', () => {
    it('All plugins define tools with parametersSchema', () => {
      plugins.forEach(plugin => {
        const manifestPath = join(pluginsDir, plugin.name, 'src', 'manifest.ts');
        const content = readFileSync(manifestPath, 'utf-8');
        
        // Count tool definitions
        const toolMatches = content.match(/name:\s*"([^"]+)"/g);
        expect(toolMatches).toBeTruthy();
        expect(toolMatches!.length).toBeGreaterThanOrEqual(plugin.expectedTools);
        
        // Check for parametersSchema in tools
        const schemaMatches = content.match(/parametersSchema:\s*{/g);
        expect(schemaMatches).toBeTruthy();
        expect(schemaMatches!.length).toBeGreaterThanOrEqual(plugin.expectedTools);
      });
    });

    it('Ruflo Bridge has orchestration tools', () => {
      const manifestPath = join(pluginsDir, 'ruflo-bridge', 'src', 'manifest.ts');
      const content = readFileSync(manifestPath, 'utf-8');
      
      const criticalTools = ['agent_spawn', 'swarm_init', 'memory_store', 'memory_search', 'workflow_create'];
      criticalTools.forEach(tool => {
        expect(content).toContain(`name: "${tool}"`);
      });
    });

    it('Skills Hub has discovery tools', () => {
      const manifestPath = join(pluginsDir, 'skills-hub', 'src', 'manifest.ts');
      const content = readFileSync(manifestPath, 'utf-8');
      
      const discoveryTools = ['search_skills', 'get_skill', 'get_trending', 'get_top_rated'];
      discoveryTools.forEach(tool => {
        expect(content).toContain(`name: "${tool}"`);
      });
    });

    it('Playwright MCP has browser automation tools', () => {
      const manifestPath = join(pluginsDir, 'playwright-mcp', 'src', 'manifest.ts');
      const content = readFileSync(manifestPath, 'utf-8');
      
      const browserTools = ['browser_navigate', 'browser_click', 'browser_fill', 'browser_screenshot'];
      browserTools.forEach(tool => {
        expect(content).toContain(`name: "${tool}"`);
      });
    });
  });

  describe('Documentation Completeness', () => {
    it('All plugin READMEs have usage examples', () => {
      plugins.forEach(plugin => {
        const readmePath = join(pluginsDir, plugin.name, 'README.md');
        const content = readFileSync(readmePath, 'utf-8');
        
        expect(content).toContain('##');
        expect(content).toContain('```');
        expect(content.length).toBeGreaterThan(1000);
      });
    });

    it('Plugin docs are registered in docs.json', () => {
      const docsJsonPath = join(__dirname, '../../../docs/docs.json');
      const docsConfig = JSON.parse(readFileSync(docsJsonPath, 'utf-8'));
      
      const pluginsTab = docsConfig.navigation.tabs.find(
        (tab: any) => tab.tab === 'Plugins'
      );
      
      expect(pluginsTab).toBeDefined();
      
      const pluginPages = pluginsTab.groups.flatMap((g: any) => g.pages || []);
      expect(pluginPages).toContain('plugins/playwright-mcp');
      expect(pluginPages).toContain('plugins/ruflo-bridge');
      expect(pluginPages).toContain('plugins/skills-hub');
    });
  });

  describe('Build Output Validation', () => {
    it('All plugins have dist/index.js', () => {
      plugins.forEach(plugin => {
        const indexPath = join(pluginsDir, plugin.name, 'dist', 'index.js');
        expect(existsSync(indexPath)).toBe(true);
        
        const content = readFileSync(indexPath, 'utf-8');
        expect(content.length).toBeGreaterThan(50);
      });
    });

    it('Ruflo Bridge and Skills Hub have dist/worker.js', () => {
      ['ruflo-bridge', 'skills-hub'].forEach(pluginName => {
        const workerPath = join(pluginsDir, pluginName, 'dist', 'worker.js');
        expect(existsSync(workerPath)).toBe(true);
      });
    });
  });
});
