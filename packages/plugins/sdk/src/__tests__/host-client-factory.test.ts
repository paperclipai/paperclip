/**
 * host-client-factory.ts Unit Tests
 * 
 * Tests for CapabilityDeniedError and capability gating logic.
 */

import { describe, it, expect } from 'vitest';
import { CapabilityDeniedError } from '../host-client-factory.js';
import { PLUGIN_RPC_ERROR_CODES } from '../protocol.js';

describe('CapabilityDeniedError', () => {
  describe('Construction', () => {
    it('creates error with correct name and code', () => {
      const error = new CapabilityDeniedError('test-plugin', 'state.get', 'plugin.state.read');
      
      expect(error.name).toBe('CapabilityDeniedError');
      expect(error.code).toBe(PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED);
      expect(error.code).toBe(-32001);
    });

    it('includes pluginId in message', () => {
      const error = new CapabilityDeniedError('acme.linear', 'state.get', 'plugin.state.read');
      
      expect(error.message).toContain('acme.linear');
    });

    it('includes method in message', () => {
      const error = new CapabilityDeniedError('test-plugin', 'state.get', 'plugin.state.read');
      
      expect(error.message).toContain('state.get');
    });

    it('includes capability in message', () => {
      const error = new CapabilityDeniedError('test-plugin', 'state.get', 'plugin.state.read');
      
      expect(error.message).toContain('plugin.state.read');
    });

    it('formats message correctly', () => {
      const error = new CapabilityDeniedError('my-plugin', 'state.set', 'plugin.state.write');
      
      expect(error.message).toBe(
        'Plugin "my-plugin" is missing required capability "plugin.state.write" for method "state.set"'
      );
    });
  });

  describe('Error Properties', () => {
    it('has readable stack trace', () => {
      const error = new CapabilityDeniedError('test', 'state.set', 'plugin.state.write');
      
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('CapabilityDeniedError');
    });

    it('preserves cause chain', () => {
      try {
        throw new CapabilityDeniedError('test', 'state.set', 'plugin.state.write');
      } catch (e) {
        expect(e).toBeInstanceOf(CapabilityDeniedError);
        expect((e as Error).message).toContain('missing required capability');
      }
    });
  });

  describe('Usage Patterns', () => {
    it('can be caught and rethrown', () => {
      const testFn = () => {
        throw new CapabilityDeniedError('plugin', 'state.set', 'plugin.state.write');
      };
      
      expect(testFn).toThrow(CapabilityDeniedError);
      expect(testFn).toThrow('missing required capability');
    });

    it('can be distinguished from generic Error', () => {
      const capabilityError = new CapabilityDeniedError('plugin', 'state.set', 'plugin.state.write');
      const genericError = new Error('Generic error');
      
      expect(capabilityError instanceof CapabilityDeniedError).toBe(true);
      expect(genericError instanceof CapabilityDeniedError).toBe(false);
      expect(capabilityError.name).toBe('CapabilityDeniedError');
      expect(genericError.name).toBe('Error');
    });

    it('can be caught by name', () => {
      try {
        throw new CapabilityDeniedError('plugin', 'state.set', 'plugin.state.write');
      } catch (e) {
        if (e instanceof Error) {
          expect(e.name).toBe('CapabilityDeniedError');
        }
      }
    });
  });

  describe('Different Capabilities', () => {
    it('handles state.read capability', () => {
      const error = new CapabilityDeniedError('plugin', 'state.get', 'plugin.state.read');
      expect(error.message).toContain('plugin.state.read');
    });

    it('handles state.write capability', () => {
      const error = new CapabilityDeniedError('plugin', 'state.set', 'plugin.state.write');
      expect(error.message).toContain('plugin.state.write');
    });

    it('handles events.emit capability', () => {
      const error = new CapabilityDeniedError('plugin', 'emit', 'events.emit');
      expect(error.message).toContain('events.emit');
    });

    it('handles http.outbound capability', () => {
      const error = new CapabilityDeniedError('plugin', 'fetch', 'http.outbound');
      expect(error.message).toContain('http.outbound');
    });

    it('handles secrets.read-ref capability', () => {
      const error = new CapabilityDeniedError('plugin', 'secrets.resolve', 'secrets.read-ref');
      expect(error.message).toContain('secrets.read-ref');
    });
  });

  describe('Edge Cases', () => {
    it('handles empty pluginId', () => {
      const error = new CapabilityDeniedError('', 'state.set', 'plugin.state.write');
      expect(error.message).toContain('Plugin ""');
    });

    it('handles empty method', () => {
      const error = new CapabilityDeniedError('plugin', '', 'plugin.state.write');
      expect(error.message).toContain('method ""');
    });

    it('handles empty capability', () => {
      const error = new CapabilityDeniedError('plugin', 'state.set', 'plugin.state.read');
      expect(error.message).toContain('capability');
    });

    it('handles special characters in pluginId', () => {
      const error = new CapabilityDeniedError('plugin-with-dashes', 'state.set', 'plugin.state.write');
      expect(error.message).toContain('plugin-with-dashes');
    });

    it('handles dots in capability name', () => {
      const error = new CapabilityDeniedError('plugin', 'state.set', 'plugin.state.write');
      expect(error.message).toContain('plugin.state.write');
    });
  });
});

describe('PLUGIN_RPC_ERROR_CODES integration', () => {
  it('CapabilityDeniedError uses correct error code from PLUGIN_RPC_ERROR_CODES', () => {
    const error = new CapabilityDeniedError('plugin', 'state.set', 'plugin.state.write');
    expect(error.code).toBe(PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED);
    expect(PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED).toBe(-32001);
  });

  it('CAPABILITY_DENIED is in server-reserved range', () => {
    const code = PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED;
    expect(code).toBeGreaterThanOrEqual(-32099);
    expect(code).toBeLessThanOrEqual(-32000);
  });
});
