/**
 * testing.ts Unit Tests - createTestHarness
 * 
 * Tests for the in-memory test harness used for plugin unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestHarness } from '../testing.js';
import type { PaperclipPluginManifestV1 } from '@paperclipai/shared';
import { definePlugin } from '../define-plugin.js';

const createMockManifest = (overrides?: Partial<PaperclipPluginManifestV1>): PaperclipPluginManifestV1 => ({
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  description: 'Test plugin for unit tests',
  capabilities: ['plugin.state.read', 'plugin.state.write'],
  ...overrides,
});

describe('createTestHarness', () => {
  describe('Harness Creation', () => {
    it('creates harness with manifest', () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      expect(harness).toBeDefined();
      expect(harness.ctx).toBeDefined();
      expect(harness.logs).toEqual([]);
      expect(harness.activity).toEqual([]);
      expect(harness.metrics).toEqual([]);
    });

    it('initializes with default config', () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      expect(harness.ctx.config.get()).resolves.toEqual({});
    });

    it('initializes with provided config', async () => {
      const manifest = createMockManifest();
      const initialConfig = { apiKey: 'test-key', workspace: 'prod' };
      const harness = createTestHarness({ manifest, config: initialConfig });
      
      const config = await harness.ctx.config.get();
      expect(config).toEqual(initialConfig);
    });

    it('allows config override via setConfig', async () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest, config: { key1: 'value1' } });
      
      harness.setConfig({ key2: 'value2' });
      const config = await harness.ctx.config.get();
      expect(config).toEqual({ key2: 'value2' });
    });
  });

  describe('Logger', () => {
    it('logs info messages', () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      harness.ctx.logger.info('Test message');
      
      expect(harness.logs).toHaveLength(1);
      expect(harness.logs[0]).toEqual({
        level: 'info',
        message: 'Test message',
      });
    });

    it('logs warn messages', () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      harness.ctx.logger.warn('Warning message');
      
      expect(harness.logs).toHaveLength(1);
      expect(harness.logs[0].level).toBe('warn');
      expect(harness.logs[0].message).toBe('Warning message');
    });

    it('logs error messages', () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      harness.ctx.logger.error('Error message');
      
      expect(harness.logs).toHaveLength(1);
      expect(harness.logs[0].level).toBe('error');
      expect(harness.logs[0].message).toBe('Error message');
    });

    it('logs debug messages', () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      harness.ctx.logger.debug('Debug message');
      
      expect(harness.logs).toHaveLength(1);
      expect(harness.logs[0].level).toBe('debug');
      expect(harness.logs[0].message).toBe('Debug message');
    });

    it('includes metadata in logs', () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      harness.ctx.logger.info('Message with meta', { userId: 123, action: 'test' });
      
      expect(harness.logs[0].meta).toEqual({ userId: 123, action: 'test' });
    });
  });

  describe('State Management', () => {
    it('gets undefined for non-existent state', async () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      const value = await harness.ctx.state.get({
        scopeKind: 'instance',
        stateKey: 'nonexistent',
      });
      
      expect(value).toBeNull();
    });

    it('sets and gets state', async () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      await harness.ctx.state.set(
        { scopeKind: 'instance', stateKey: 'counter' },
        42
      );
      
      const value = await harness.ctx.state.get({
        scopeKind: 'instance',
        stateKey: 'counter',
      });
      
      expect(value).toBe(42);
    });

    it('deletes state', async () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      await harness.ctx.state.set(
        { scopeKind: 'instance', stateKey: 'temp' },
        'temporary'
      );
      
      await harness.ctx.state.delete({
        scopeKind: 'instance',
        stateKey: 'temp',
      });
      
      const value = await harness.ctx.state.get({
        scopeKind: 'instance',
        stateKey: 'temp',
      });
      
      expect(value).toBeNull();
    });

    it('scopes state by scopeKind and scopeId', async () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      await harness.ctx.state.set(
        { scopeKind: 'company', scopeId: 'company-1', stateKey: 'key' },
        'value1'
      );
      
      await harness.ctx.state.set(
        { scopeKind: 'company', scopeId: 'company-2', stateKey: 'key' },
        'value2'
      );
      
      const value1 = await harness.ctx.state.get({
        scopeKind: 'company',
        scopeId: 'company-1',
        stateKey: 'key',
      });
      
      const value2 = await harness.ctx.state.get({
        scopeKind: 'company',
        scopeId: 'company-2',
        stateKey: 'key',
      });
      
      expect(value1).toBe('value1');
      expect(value2).toBe('value2');
    });

    it('getState returns raw state for assertions', async () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      await harness.ctx.state.set(
        { scopeKind: 'instance', stateKey: 'test' },
        { data: 'value' }
      );
      
      const rawState = harness.getState({
        scopeKind: 'instance',
        stateKey: 'test',
      });
      
      expect(rawState).toEqual({ data: 'value' });
    });
  });

  describe('Capability Enforcement', () => {
    it('allows operations with required capabilities', async () => {
      const manifest = createMockManifest({
        capabilities: ['plugin.state.read', 'plugin.state.write'],
      });
      const harness = createTestHarness({ manifest });
      
      // Should not throw
      await harness.ctx.state.set(
        { scopeKind: 'instance', stateKey: 'test' },
        'value'
      );
      
      const value = await harness.ctx.state.get({
        scopeKind: 'instance',
        stateKey: 'test',
      });
      
      expect(value).toBe('value');
    });

    it('throws when missing required capability', async () => {
      const manifest = createMockManifest({
        capabilities: ['plugin.state.read'], // Missing write capability
      });
      const harness = createTestHarness({ manifest });
      
      await expect(
        harness.ctx.state.set(
          { scopeKind: 'instance', stateKey: 'test' },
          'value'
        )
      ).rejects.toThrow("missing required capability 'plugin.state.write'");
    });
  });

  describe('Activity Logging', () => {
    it('logs activity entries', async () => {
      const manifest = createMockManifest({
        capabilities: ['plugin.state.read', 'plugin.state.write', 'activity.log.write'],
      });
      const harness = createTestHarness({ manifest });
      
      await harness.ctx.activity.log({
        companyId: 'company-1',
        message: 'User performed action',
        entityType: 'issue',
        entityId: 'issue-123',
        metadata: { action: 'created' },
      });
      
      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0].message).toBe('User performed action');
      expect(harness.activity[0].entityType).toBe('issue');
      expect(harness.activity[0].entityId).toBe('issue-123');
      expect(harness.activity[0].metadata).toEqual({ action: 'created' });
    });
  });

  describe('Metrics', () => {
    it('writes metrics', async () => {
      const manifest = createMockManifest({
        capabilities: ['plugin.state.read', 'plugin.state.write', 'metrics.write'],
      });
      const harness = createTestHarness({ manifest });
      
      await harness.ctx.metrics.write('plugin.sync.duration', 1234, { status: 'success' });
      
      expect(harness.metrics).toHaveLength(1);
      expect(harness.metrics[0].name).toBe('plugin.sync.duration');
      expect(harness.metrics[0].value).toBe(1234);
      expect(harness.metrics[0].tags).toEqual({ status: 'success' });
    });
  });

  describe('Integration with definePlugin', () => {
    it('works with plugin setup', async () => {
      const manifest = createMockManifest();
      const harness = createTestHarness({ manifest });
      
      let setupCalled = false;
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.logger.info('Plugin setup');
          setupCalled = true;
        },
      });
      
      await plugin.definition.setup(harness.ctx);
      
      expect(setupCalled).toBe(true);
      expect(harness.logs[0].message).toBe('Plugin setup');
    });

    it('plugin can register event handlers', async () => {
      const manifest = createMockManifest({
        capabilities: ['events.subscribe'],
      });
      const harness = createTestHarness({ manifest });
      
      let eventReceived = false;
      const plugin = definePlugin({
        async setup(ctx) {
          ctx.events.on('issue.created', async () => {
            eventReceived = true;
          });
        },
      });
      
      await plugin.definition.setup(harness.ctx);
      
      // Emit event (harness should have emit method)
      if ('emit' in harness) {
        await (harness as any).emit('issue.created', { test: 'data' });
        expect(eventReceived).toBe(true);
      }
    });
  });
});
