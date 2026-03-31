/**
 * protocol.ts Unit Tests - Additional Coverage
 * 
 * Tests for JSON-RPC protocol helpers, error handling, and edge cases
 * not covered in sdk-api.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  MESSAGE_DELIMITER,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createNotification,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  serializeMessage,
  parseMessage,
  JsonRpcParseError,
  JsonRpcCallError,
  _resetIdCounter,
} from '../protocol.js';

describe('JSON-RPC Protocol - Additional Coverage', () => {
  beforeEach(() => {
    // Reset ID counter before each test for deterministic testing
    _resetIdCounter();
  });

  describe('ID Counter Management', () => {
    it('generates sequential IDs starting from 1', () => {
      _resetIdCounter();
      const req1 = createRequest('method1', {});
      const req2 = createRequest('method2', {});
      const req3 = createRequest('method3', {});
      
      expect(req1.id).toBe(1);
      expect(req2.id).toBe(2);
      expect(req3.id).toBe(3);
    });

    it('resets ID counter when _resetIdCounter is called', () => {
      const req1 = createRequest('method1', {});
      expect(req1.id).toBe(1);
      
      _resetIdCounter();
      
      const req2 = createRequest('method2', {});
      expect(req2.id).toBe(1);
    });
  });

  describe('createRequest with various parameter types', () => {
    it('handles null parameters', () => {
      const request = createRequest('method', null);
      expect(request.params).toBeNull();
    });

    it('handles array parameters', () => {
      const request = createRequest('method', [1, 2, 3]);
      expect(request.params).toEqual([1, 2, 3]);
    });

    it('handles nested object parameters', () => {
      const params = {
        user: { id: 1, name: 'Test' },
        settings: { theme: 'dark', notifications: true },
      };
      const request = createRequest('method', params);
      expect(request.params).toEqual(params);
    });

    it('handles undefined parameters (converted to empty object)', () => {
      const request = createRequest('method', undefined);
      expect(request.params).toBeUndefined();
    });
  });

  describe('createErrorResponse with error data', () => {
    it('includes optional error data', () => {
      const errorData = {
        field: 'email',
        constraint: 'required',
        value: null,
      };
      const response = createErrorResponse(123, -32602, 'Invalid params', errorData);
      
      expect(response.error).toBeDefined();
      expect(response.error!.data).toEqual(errorData);
    });

    it('handles complex error data', () => {
      const errorData = {
        validationErrors: [
          { field: 'email', message: 'Required' },
          { field: 'password', message: 'Min 8 chars' },
        ],
        errorCode: 'VALIDATION_FAILED',
      };
      const response = createErrorResponse(456, -32602, 'Validation failed', errorData);
      
      expect(response.error!.data).toEqual(errorData);
    });

    it('omits data when not provided', () => {
      const response = createErrorResponse(789, -32601, 'Method not found');
      
      expect(response.error!.data).toBeUndefined();
    });
  });

  describe('createNotification edge cases', () => {
    it('creates notification with empty params', () => {
      const notification = createNotification('event', {});
      expect(notification.params).toEqual({});
    });

    it('creates notification with primitive params', () => {
      const notification = createNotification('event', 'simple-string');
      expect(notification.params).toBe('simple-string');
    });
  });

  describe('Type Guards - Edge Cases', () => {
    describe('isJsonRpcRequest', () => {
      it('rejects null and undefined', () => {
        expect(isJsonRpcRequest(null)).toBe(false);
        expect(isJsonRpcRequest(undefined)).toBe(false);
      });

      it('rejects non-objects', () => {
        expect(isJsonRpcRequest('string')).toBe(false);
        expect(isJsonRpcRequest(123)).toBe(false);
        expect(isJsonRpcRequest(true)).toBe(false);
      });

      it('rejects objects missing required fields', () => {
        expect(isJsonRpcRequest({})).toBe(false);
        expect(isJsonRpcRequest({ jsonrpc: '2.0' })).toBe(false);
        expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test' })).toBe(false);
      });

      it('rejects wrong jsonrpc version', () => {
        expect(isJsonRpcRequest({ jsonrpc: '1.0', method: 'test', id: 1 })).toBe(false);
        expect(isJsonRpcRequest({ jsonrpc: 2.0, method: 'test', id: 1 })).toBe(false);
      });

      it('rejects notification (no id)', () => {
        const notification = createNotification('event', {});
        expect(isJsonRpcRequest(notification)).toBe(false);
      });

      it('rejects when id is null', () => {
        expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test', id: null })).toBe(false);
      });

      it('accepts valid request with string id', () => {
        expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test', id: 'uuid-123' })).toBe(true);
      });

      it('accepts valid request with number id', () => {
        expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test', id: 42 })).toBe(true);
      });
    });

    describe('isJsonRpcNotification', () => {
      it('rejects null and undefined', () => {
        expect(isJsonRpcNotification(null)).toBe(false);
        expect(isJsonRpcNotification(undefined)).toBe(false);
      });

      it('rejects objects with id field', () => {
        const request = createRequest('method', {});
        expect(isJsonRpcNotification(request)).toBe(false);
      });

      it('accepts valid notification', () => {
        const notification = createNotification('event', {});
        expect(isJsonRpcNotification(notification)).toBe(true);
      });

      it('rejects if method is not string', () => {
        expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 123 })).toBe(false);
      });
    });

    describe('isJsonRpcResponse', () => {
      it('rejects null and undefined', () => {
        expect(isJsonRpcResponse(null)).toBe(false);
        expect(isJsonRpcResponse(undefined)).toBe(false);
      });

      it('rejects objects without id', () => {
        expect(isJsonRpcResponse({ jsonrpc: '2.0', result: 'ok' })).toBe(false);
      });

      it('rejects objects without result or error', () => {
        expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1 })).toBe(false);
      });

      it('accepts success response', () => {
        const response = createSuccessResponse(1, { data: 'ok' });
        expect(isJsonRpcResponse(response)).toBe(true);
      });

      it('accepts error response', () => {
        const response = createErrorResponse(1, -32600, 'Invalid request');
        expect(isJsonRpcResponse(response)).toBe(true);
      });
    });

    describe('isJsonRpcSuccessResponse', () => {
      it('identifies response with result and no error', () => {
        const response = createSuccessResponse(1, { data: 'ok' });
        expect(isJsonRpcSuccessResponse(response)).toBe(true);
      });

      it('rejects error response', () => {
        const response = createErrorResponse(1, -32600, 'Error');
        expect(isJsonRpcSuccessResponse(response)).toBe(false);
      });

      it('rejects response with both result and error', () => {
        const response = {
          jsonrpc: '2.0' as const,
          id: 1,
          result: { data: 'ok' },
          error: { code: -32600, message: 'Error' },
        };
        expect(isJsonRpcSuccessResponse(response as any)).toBe(false);
      });
    });

    describe('isJsonRpcErrorResponse', () => {
      it('identifies response with error', () => {
        const response = createErrorResponse(1, -32600, 'Error');
        expect(isJsonRpcErrorResponse(response)).toBe(true);
      });

      it('rejects success response', () => {
        const response = createSuccessResponse(1, { data: 'ok' });
        expect(isJsonRpcErrorResponse(response)).toBe(false);
      });
    });
  });

  describe('serializeMessage', () => {
    it('handles large objects', () => {
      const largeObj = {
        data: Array(100).fill('item'),
        metadata: { timestamp: Date.now(), version: '1.0' },
      };
      const serialized = serializeMessage(createRequest('method', largeObj));
      
      expect(serialized).toContain('data');
      expect(serialized).toContain('metadata');
      expect(serialized.endsWith('\n')).toBe(true);
    });

    it('handles special characters in strings', () => {
      const params = { text: 'Hello\nWorld\t"quoted"' };
      const serialized = serializeMessage(createRequest('method', params));
      const parsed = JSON.parse(serialized.trim());
      expect(parsed.params.text).toBe('Hello\nWorld\t"quoted"');
    });
  });

  describe('parseMessage - Validation', () => {
    it('rejects empty string', () => {
      expect(() => parseMessage('')).toThrow(JsonRpcParseError);
      expect(() => parseMessage('')).toThrow('Empty message');
    });

    it('rejects whitespace-only string', () => {
      expect(() => parseMessage('   \n\t  ')).toThrow(JsonRpcParseError);
    });

    it('rejects non-JSON-object messages', () => {
      expect(() => parseMessage('"just a string"')).toThrow(JsonRpcParseError);
      expect(() => parseMessage('123')).toThrow(JsonRpcParseError);
      expect(() => parseMessage('true')).toThrow(JsonRpcParseError);
      expect(() => parseMessage('null')).toThrow(JsonRpcParseError);
      expect(() => parseMessage('[1, 2, 3]')).toThrow(JsonRpcParseError);
    });

    it('rejects objects without jsonrpc field', () => {
      expect(() => parseMessage('{"method": "test"}')).toThrow(JsonRpcParseError);
    });

    it('rejects wrong jsonrpc version', () => {
      expect(() => parseMessage('{"jsonrpc": "1.0"}')).toThrow(JsonRpcParseError);
      expect(() => parseMessage('{"jsonrpc": 2.0}')).toThrow(JsonRpcParseError);
    });

    it('trims trailing newline before parsing', () => {
      const message = '{"jsonrpc": "2.0", "id": 1, "result": "ok"}\n';
      const parsed = parseMessage(message);
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: 'ok',
      });
    });

    it('trims leading whitespace', () => {
      const message = '  \n{"jsonrpc": "2.0", "id": 1, "result": "ok"}';
      const parsed = parseMessage(message);
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: 'ok',
      });
    });

    it('truncates error message for very long invalid JSON', () => {
      const longString = 'x'.repeat(500);
      try {
        parseMessage(longString);
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toContain('Invalid JSON');
        expect((e as Error).message.length).toBeLessThan(300); // Truncated
      }
    });
  });

  describe('JsonRpcParseError', () => {
    it('has correct name property', () => {
      const error = new JsonRpcParseError('Test error');
      expect(error.name).toBe('JsonRpcParseError');
      expect(error.message).toBe('Test error');
    });

    it('can be caught and rethrown', () => {
      try {
        throw new JsonRpcParseError('Original error');
      } catch (e) {
        expect(e).toBeInstanceOf(JsonRpcParseError);
        expect((e as Error).message).toBe('Original error');
      }
    });
  });

  describe('JsonRpcCallError', () => {
    it('captures error code and message', () => {
      const rpcError = { code: -32601, message: 'Method not found' };
      const error = new JsonRpcCallError(rpcError);
      
      expect(error.name).toBe('JsonRpcCallError');
      expect(error.message).toBe('Method not found');
      expect(error.code).toBe(-32601);
      expect(error.data).toBeUndefined();
    });

    it('captures error data when provided', () => {
      const rpcError = {
        code: -32602,
        message: 'Invalid params',
        data: { field: 'email' },
      };
      const error = new JsonRpcCallError(rpcError);
      
      expect(error.code).toBe(-32602);
      expect(error.data).toEqual({ field: 'email' });
    });

    it('preserves stack trace', () => {
      const error = new JsonRpcCallError({ code: -32600, message: 'Error' });
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('JsonRpcCallError');
    });
  });

  describe('Plugin RPC Error Codes', () => {
    it('PLUGIN_RPC_ERROR_CODES has all expected codes', () => {
      expect(PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE).toBe(-32000);
      expect(PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED).toBe(-32001);
      expect(PLUGIN_RPC_ERROR_CODES.WORKER_ERROR).toBe(-32002);
      expect(PLUGIN_RPC_ERROR_CODES.TIMEOUT).toBe(-32003);
      expect(PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED).toBe(-32004);
      expect(PLUGIN_RPC_ERROR_CODES.UNKNOWN).toBe(-32099);
    });

    it('error codes are in server-reserved range', () => {
      Object.values(PLUGIN_RPC_ERROR_CODES).forEach(code => {
        expect(code).toBeGreaterThanOrEqual(-32099);
        expect(code).toBeLessThanOrEqual(-32000);
      });
    });
  });

  describe('MESSAGE_DELIMITER', () => {
    it('is a newline character', () => {
      expect(MESSAGE_DELIMITER).toBe('\n');
    });

    it('is used by serializeMessage', () => {
      const msg = createRequest('test', {});
      const serialized = serializeMessage(msg);
      expect(serialized.split('\n').length).toBe(2); // JSON + newline creates 2 parts
    });
  });
});
