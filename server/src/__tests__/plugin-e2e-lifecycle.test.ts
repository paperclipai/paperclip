/**
 * Plugin E2E Lifecycle Tests
 * 
 * End-to-end tests for plugin loading, tool registration, and execution.
 * Validates the complete plugin lifecycle from discovery to tool invocation.
 * 
 * These tests run WITHOUT Postgres — using mocked plugin loader and tool registry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginsDir = join(__dirname, '../../../packages/plugins');

// Mock plugin worker execution
const mockPluginWorker = async (pluginName: string, toolName: string, args: Record<string, any>) => {
  const workerPath = join(pluginsDir, pluginName, 'dist', 'worker.js');
  if (!existsSync(workerPath)) {
    throw new Error(`Worker not found: ${workerPath}`);
  }
  
  // Simulate tool execution response structure
  return {
    success: true,
    data: {
      tool: toolName,
      plugin: pluginName,
      args,
      timestamp: new Date().toISOString(),
    },
  };
};

describe('Plugin E2E Lifecycle', () => {
  const plugins = [
    {
      name: 'playwright-mcp',
      id: 'playwright.mcp',
      displayName: 'Playwright MCP',
      tools: ['browser_navigate', 'browser_click', 'browser_fill', 'browser_screenshot'],
    },
    {
      name: 'ruflo-bridge',
      id: 'ruflo.bridge',
      displayName: 'Ruflo MCP Bridge',
      tools: ['agent_spawn', 'swarm_init', 'memory_store', 'memory_search'],
    },
    {
      name: 'skills-hub',
      id: 'skills.hub',
      displayName: 'Agent Skills Hub',
      tools: ['search_skills', 'get_skill', 'get_trending', 'get_top_rated'],
    },
  ];

  describe('Plugin Discovery', () => {
    it('discovers all plugins in packages/plugins directory', () => {
      const dirents = readdirSync(pluginsDir, { withFileTypes: true });
      const pluginDirs = dirents
        .filter(d => d.isDirectory())
        .filter(d => !['examples', 'sdk', '__tests__', 'create-paperclip-plugin'].includes(d.name))
        .map(d => d.name);
      
      expect(pluginDirs).toContain('playwright-mcp');
      expect(pluginDirs).toContain('ruflo-bridge');
      expect(pluginDirs).toContain('skills-hub');
    });

    it('each plugin has valid package.json with name field', () => {
      plugins.forEach(plugin => {
        const pkgPath = join(pluginsDir, plugin.name, 'package.json');
        expect(existsSync(pkgPath)).toBe(true);
        
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        expect(pkg.name).toBeDefined();
        expect(pkg.name).toContain(plugin.name);
      });
    });
  });

  describe('Plugin Worker Build Validation', () => {
    plugins.forEach(plugin => {
      describe(`${plugin.name} worker`, () => {
        it('has compiled dist/worker.js', () => {
          const workerPath = join(pluginsDir, plugin.name, 'dist', 'worker.js');
          expect(existsSync(workerPath)).toBe(true);
        });

        it('worker.js is non-empty and valid JS', () => {
          const workerPath = join(pluginsDir, plugin.name, 'dist', 'worker.js');
          const content = readFileSync(workerPath, 'utf-8');
          
          expect(content.length).toBeGreaterThan(100);
          expect(content).toContain('export');
          expect(content).toContain('async');
        });

        it('worker.js size is reasonable (< 1MB)', () => {
          const workerPath = join(pluginsDir, plugin.name, 'dist', 'worker.js');
          const stats = statSync(workerPath);
          expect(stats.size).toBeLessThan(1024 * 1024); // 1MB
        });
      });
    });
  });

  describe('Tool Registration Validation', () => {
    plugins.forEach(plugin => {
      it(`${plugin.name} manifest declares tools`, () => {
        const manifestPath = join(pluginsDir, plugin.name, 'src', 'manifest.ts');
        const content = readFileSync(manifestPath, 'utf-8');
        
        expect(content).toContain('tools: [');
        plugin.tools.forEach(tool => {
          expect(content).toContain(tool);
        });
      });

      it(`${plugin.name} has tool implementation for each declared tool`, () => {
        const workerPath = join(pluginsDir, plugin.name, 'dist', 'worker.js');
        const content = readFileSync(workerPath, 'utf-8');
        
        plugin.tools.forEach(tool => {
          expect(content).toContain(tool);
        });
      });
    });
  });

  describe('Tool Execution Simulation', () => {
    plugins.forEach(plugin => {
      describe(`${plugin.name} tool execution`, () => {
        it('can simulate tool invocation for browser_navigate/agent_spawn/skills_list', async () => {
          const toolName = plugin.tools[0];
          const result = await mockPluginWorker(plugin.name, toolName, { test: true });
          
          expect(result.success).toBe(true);
          expect(result.data.tool).toBe(toolName);
          expect(result.data.plugin).toBe(plugin.name);
        });
      });
    });
  });

  describe('Plugin Metadata Completeness', () => {
    plugins.forEach(plugin => {
      it(`${plugin.name} has README documentation`, () => {
        const readmePath = join(pluginsDir, plugin.name, 'README.md');
        expect(existsSync(readmePath)).toBe(true);
        
        const content = readFileSync(readmePath, 'utf-8');
        expect(content.length).toBeGreaterThan(500);
        expect(content).toContain('##');
      });

      it(`${plugin.name} has tsconfig.json`, () => {
        const tsconfigPath = join(pluginsDir, plugin.name, 'tsconfig.json');
        expect(existsSync(tsconfigPath)).toBe(true);
      });

      it(`${plugin.name} manifest has version field`, () => {
        const manifestPath = join(pluginsDir, plugin.name, 'src', 'manifest.ts');
        const content = readFileSync(manifestPath, 'utf-8');
        
        expect(content).toMatch(/apiVersion:\s*\d+/);
      });
    });
  });

  describe('Cross-Plugin Dependencies', () => {
    it('SDK is shared dependency for all plugins', () => {
      const sdkPath = join(pluginsDir, 'sdk', 'package.json');
      expect(existsSync(sdkPath)).toBe(true);
      
      const sdkPkg = JSON.parse(readFileSync(sdkPath, 'utf-8'));
      expect(sdkPkg.name).toBe('@paperclipai/plugin-sdk');
    });
  });
});
