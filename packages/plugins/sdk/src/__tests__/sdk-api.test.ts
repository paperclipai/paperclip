/**
 * SDK API Unit Tests
 * 
 * Validates the core SDK exports and API surface for plugin development.
 * Ensures backward compatibility and correct type exports.
 */

import { describe, it, expect } from 'vitest';
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
} from '../protocol.js';

describe('Plugin SDK Protocol API', () => {
  describe('JSON-RPC Protocol Constants', () => {
    it('JSONRPC_VERSION is 2.0', () => {
      expect(JSONRPC_VERSION).toBe('2.0');
    });

    it('JSONRPC_ERROR_CODES has standard codes', () => {
      expect(JSONRPC_ERROR_CODES).toBeDefined();
      expect(JSONRPC_ERROR_CODES.PARSE_ERROR).toBe(-32700);
      expect(JSONRPC_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
      expect(JSONRPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
      expect(JSONRPC_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
      expect(JSONRPC_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
    });

    it('PLUGIN_RPC_ERROR_CODES has plugin-specific codes', () => {
      expect(PLUGIN_RPC_ERROR_CODES).toBeDefined();
      expect(PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE).toBe(-32000);
      expect(PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED).toBe(-32001);
      expect(PLUGIN_RPC_ERROR_CODES.WORKER_ERROR).toBe(-32002);
    });

    it('MESSAGE_DELIMITER is newline', () => {
      expect(MESSAGE_DELIMITER).toBe('\n');
    });
  });

  describe('JSON-RPC Message Creation', () => {
    it('createRequest generates valid request', () => {
      const request = createRequest('test.method', { param1: 'value1' });
      
      expect(request.jsonrpc).toBe('2.0');
      expect(request.method).toBe('test.method');
      expect(request.params).toEqual({ param1: 'value1' });
      expect(typeof request.id).toBe('number');
    });

    it('createSuccessResponse generates valid response', () => {
      const response = createSuccessResponse(123, { result: 'success' });
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(123);
      expect(response.result).toEqual({ result: 'success' });
      expect(response.error).toBeUndefined();
    });

    it('createErrorResponse generates valid error response', () => {
      const response = createErrorResponse(123, -32601, 'Method not found');
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(123);
      expect(response.result).toBeUndefined();
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
      expect(response.error!.message).toBe('Method not found');
    });

    it('createNotification generates valid notification', () => {
      const notification = createNotification('event.name', { data: 'test' });
      
      expect(notification.jsonrpc).toBe('2.0');
      expect(notification.method).toBe('event.name');
      expect(notification.params).toEqual({ data: 'test' });
      expect(notification.id).toBeUndefined();
    });
  });

  describe('JSON-RPC Message Type Guards', () => {
    it('isJsonRpcRequest identifies requests', () => {
      const request = createRequest('test.method', {});
      expect(isJsonRpcRequest(request)).toBe(true);
      
      const notification = createNotification('event', {});
      expect(isJsonRpcRequest(notification)).toBe(false);
    });

    it('isJsonRpcNotification identifies notifications', () => {
      const notification = createNotification('event', {});
      expect(isJsonRpcNotification(notification)).toBe(true);
      
      const request = createRequest('test.method', {});
      expect(isJsonRpcNotification(request)).toBe(false);
    });

    it('isJsonRpcResponse identifies responses', () => {
      const response = createSuccessResponse(1, {});
      expect(isJsonRpcResponse(response)).toBe(true);
      
      const request = createRequest('test.method', {});
      expect(isJsonRpcResponse(request)).toBe(false);
    });

    it('isJsonRpcSuccessResponse identifies success responses', () => {
      const success = createSuccessResponse(1, { data: 'ok' });
      expect(isJsonRpcSuccessResponse(success)).toBe(true);
      
      const error = createErrorResponse(1, -32600, 'Invalid request');
      expect(isJsonRpcSuccessResponse(error)).toBe(false);
    });

    it('isJsonRpcErrorResponse identifies error responses', () => {
      const error = createErrorResponse(1, -32600, 'Invalid request');
      expect(isJsonRpcErrorResponse(error)).toBe(true);
      
      const success = createSuccessResponse(1, { data: 'ok' });
      expect(isJsonRpcErrorResponse(success)).toBe(false);
    });
  });

  describe('Message Serialization', () => {
    it('serializeMessage converts object to delimited string', () => {
      const msg = { jsonrpc: '2.0' as const, method: 'test', params: {}, id: 1 };
      const serialized = serializeMessage(msg);
      
      expect(serialized).toBe('{"jsonrpc":"2.0","method":"test","params":{},"id":1}\n');
    });

    it('parseMessage converts delimited string to object', () => {
      const str = '{"jsonrpc":"2.0","result":"ok"}\n';
      const parsed = parseMessage(str);
      
      expect(parsed).toEqual({ jsonrpc: '2.0', result: 'ok' });
    });

    it('parseMessage throws on invalid JSON', () => {
      const str = 'invalid json\n';
      
      expect(() => parseMessage(str)).toThrow(JsonRpcParseError);
    });
  });

  describe('Error Classes', () => {
    it('JsonRpcParseError is throwable', () => {
      expect(() => {
        throw new JsonRpcParseError('Invalid JSON');
      }).toThrow('Invalid JSON');
    });

    it('JsonRpcCallError is throwable with error object', () => {
      const error = new JsonRpcCallError({ code: -32601, message: 'Method not found' });
      expect(error.code).toBe(-32601);
      expect(error.message).toBe('Method not found');
    });
  });
});
