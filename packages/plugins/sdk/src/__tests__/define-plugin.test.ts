/**
 * define-plugin Unit Tests
 * 
 * Validates the definePlugin factory function and plugin definition types.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { definePlugin } from '../define-plugin.js';
import type { PluginDefinition, PluginHealthDiagnostics, PluginConfigValidationResult } from '../define-plugin.js';

describe('definePlugin', () => {
  describe('Factory Function', () => {
    it('returns a frozen object with definition property', () => {
      const setup = vi.fn();
      const plugin = definePlugin({ setup });
      
      expect(plugin).toBeDefined();
      expect(plugin.definition).toBeDefined();
      expect(plugin.definition.setup).toBe(setup);
      expect(Object.isFrozen(plugin)).toBe(true);
    });

    it('prevents modification of returned plugin object', () => {
      const plugin = definePlugin({ setup: vi.fn() });
      
      expect(() => {
        (plugin as any).definition = { setup: vi.fn() };
      }).toThrow();
    });

    it('preserves all lifecycle hooks from definition', () => {
      const definition: PluginDefinition = {
        setup: vi.fn(),
        onHealth: vi.fn(),
        onConfigChanged: vi.fn(),
        onShutdown: vi.fn(),
        onValidateConfig: vi.fn(),
        onWebhook: vi.fn(),
      };
      
      const plugin = definePlugin(definition);
      
      expect(plugin.definition.setup).toBe(definition.setup);
      expect(plugin.definition.onHealth).toBe(definition.onHealth);
      expect(plugin.definition.onConfigChanged).toBe(definition.onConfigChanged);
      expect(plugin.definition.onShutdown).toBe(definition.onShutdown);
      expect(plugin.definition.onValidateConfig).toBe(definition.onValidateConfig);
      expect(plugin.definition.onWebhook).toBe(definition.onWebhook);
    });
  });

  describe('Setup Hook', () => {
    it('calls setup with plugin context', async () => {
      const mockCtx = {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        config: { get: vi.fn() },
        events: { on: vi.fn(), emit: vi.fn() },
        jobs: { register: vi.fn() },
        data: { register: vi.fn() },
        actions: { register: vi.fn() },
        tools: { register: vi.fn() },
        state: { get: vi.fn(), set: vi.fn() },
        http: { fetch: vi.fn() },
        secrets: { resolve: vi.fn() },
      };
      
      const setup = vi.fn();
      const plugin = definePlugin({ setup });
      
      await plugin.definition.setup(mockCtx as any);
      
      expect(setup).toHaveBeenCalledWith(mockCtx);
      expect(setup).toHaveBeenCalledTimes(1);
    });

    it('allows async setup', async () => {
      const setup = vi.fn().mockResolvedValue(undefined);
      const plugin = definePlugin({ setup });
      
      await expect(plugin.definition.setup({} as any)).resolves.toBeUndefined();
      expect(setup).toHaveBeenCalledTimes(1);
    });
  });

  describe('onHealth Hook', () => {
    it('returns health diagnostics with ok status', async () => {
      const onHealth = vi.fn().mockResolvedValue({ status: 'ok' });
      const plugin = definePlugin({ setup: vi.fn(), onHealth });
      
      const result = await plugin.definition.onHealth?.();
      
      expect(result).toEqual({ status: 'ok' });
      expect(result?.status).toBe('ok');
    });

    it('returns health diagnostics with degraded status', async () => {
      const onHealth = vi.fn().mockResolvedValue({
        status: 'degraded',
        message: 'High latency detected',
        details: { latency: 5000 },
      });
      const plugin = definePlugin({ setup: vi.fn(), onHealth });
      
      const result = await plugin.definition.onHealth?.();
      
      expect(result?.status).toBe('degraded');
      expect(result?.message).toBe('High latency detected');
      expect(result?.details).toEqual({ latency: 5000 });
    });

    it('returns health diagnostics with error status', async () => {
      const onHealth = vi.fn().mockResolvedValue({
        status: 'error',
        message: 'Connection failed',
      });
      const plugin = definePlugin({ setup: vi.fn(), onHealth });
      
      const result = await plugin.definition.onHealth?.();
      
      expect(result?.status).toBe('error');
      expect(result?.message).toBe('Connection failed');
    });

    it('allows optional message and details', async () => {
      const onHealth = vi.fn().mockResolvedValue({ status: 'ok' });
      const plugin = definePlugin({ setup: vi.fn(), onHealth });
      
      const result = await plugin.definition.onHealth?.();
      
      expect(result?.status).toBe('ok');
      expect(result?.message).toBeUndefined();
      expect(result?.details).toBeUndefined();
    });
  });

  describe('onConfigChanged Hook', () => {
    it('receives new configuration', async () => {
      const onConfigChanged = vi.fn();
      const plugin = definePlugin({ setup: vi.fn(), onConfigChanged });
      
      const newConfig = { apiKey: 'new-key', workspace: 'prod' };
      await plugin.definition.onConfigChanged?.(newConfig);
      
      expect(onConfigChanged).toHaveBeenCalledWith(newConfig);
      expect(onConfigChanged).toHaveBeenCalledTimes(1);
    });

    it('handles async config changes', async () => {
      const onConfigChanged = vi.fn().mockResolvedValue(undefined);
      const plugin = definePlugin({ setup: vi.fn(), onConfigChanged });
      
      await expect(
        plugin.definition.onConfigChanged?.({ key: 'value' })
      ).resolves.toBeUndefined();
    });
  });

  describe('onShutdown Hook', () => {
    it('allows async cleanup', async () => {
      const onShutdown = vi.fn().mockResolvedValue(undefined);
      const plugin = definePlugin({ setup: vi.fn(), onShutdown });
      
      await expect(plugin.definition.onShutdown?.()).resolves.toBeUndefined();
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('onValidateConfig Hook', () => {
    it('returns valid config result', async () => {
      const onValidateConfig = vi.fn().mockResolvedValue({ ok: true });
      const plugin = definePlugin({ setup: vi.fn(), onValidateConfig });
      
      const result = await plugin.definition.onValidateConfig?.({ apiKey: 'test' });
      
      expect(result).toEqual({ ok: true });
      expect(result?.ok).toBe(true);
    });

    it('returns invalid config with errors', async () => {
      const onValidateConfig = vi.fn().mockResolvedValue({
        ok: false,
        errors: ['API key is required', 'Invalid workspace format'],
      });
      const plugin = definePlugin({ setup: vi.fn(), onValidateConfig });
      
      const result = await plugin.definition.onValidateConfig?.({});
      
      expect(result?.ok).toBe(false);
      expect(result?.errors).toEqual(['API key is required', 'Invalid workspace format']);
    });

    it('returns warnings for config', async () => {
      const onValidateConfig = vi.fn().mockResolvedValue({
        ok: true,
        warnings: ['Using default timeout', 'Consider enabling caching'],
      });
      const plugin = definePlugin({ setup: vi.fn(), onValidateConfig });
      
      const result = await plugin.definition.onValidateConfig?.({});
      
      expect(result?.ok).toBe(true);
      expect(result?.warnings).toEqual(['Using default timeout', 'Consider enabling caching']);
    });
  });

  describe('onWebhook Hook', () => {
    it('receives webhook input with all required fields', async () => {
      const onWebhook = vi.fn();
      const plugin = definePlugin({ setup: vi.fn(), onWebhook });
      
      const input = {
        endpointKey: 'github-push',
        headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
        rawBody: '{"ref": "refs/heads/main"}',
        parsedBody: { ref: 'refs/heads/main' },
        requestId: 'req-123',
      };
      
      await plugin.definition.onWebhook?.(input as any);
      
      expect(onWebhook).toHaveBeenCalledWith(input);
    });

    it('handles async webhook processing', async () => {
      const onWebhook = vi.fn().mockResolvedValue(undefined);
      const plugin = definePlugin({ setup: vi.fn(), onWebhook });
      
      await expect(
        plugin.definition.onWebhook?.({
          endpointKey: 'test',
          headers: {},
          rawBody: '{}',
          requestId: 'req-456',
        } as any)
      ).resolves.toBeUndefined();
    });
  });

  describe('Type Exports', () => {
    it('PluginHealthDiagnostics type is exported', () => {
      const health: PluginHealthDiagnostics = {
        status: 'ok',
        message: 'All systems operational',
        details: { uptime: 1000 },
      };
      
      expect(health.status).toBe('ok');
    });

    it('PluginConfigValidationResult type is exported', () => {
      const result: PluginConfigValidationResult = {
        ok: true,
        warnings: ['Minor issue'],
      };
      
      expect(result.ok).toBe(true);
    });
  });
});
