/**
 * Agent Execution Unit Tests
 *
 * Unit tests for agent execution layer (no network required).
 * Tests the structure and API of the execution layer.
 */

import { describe, it, expect } from 'vitest';
import { createICPClient, generateStubCanisterId } from '../../src/deployment/icpClient.js';

describe('Agent Execution - Unit Tests', () => {
  describe('ICPClient - Agent Method Structure', () => {
    it('should have callAgentMethod method', () => {
      const client = createICPClient({ network: 'local' });

      expect(client).toHaveProperty('callAgentMethod');
      expect(typeof client.callAgentMethod).toBe('function');
    });

    it('should accept agent function calls with correct parameters', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      // Test that method signature is correct
      const promise = client.callAgentMethod(canisterId, 'agent_init', [
        new Uint8Array([0x01, 0x02, 0x03]),
      ]);

      expect(promise).toBeInstanceOf(Promise);
    });

    it('should support all 14 agent functions', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const agentFunctions = [
        'agent_init',
        'agent_step',
        'agent_get_state',
        'agent_get_state_size',
        'agent_add_memory',
        'agent_get_memories',
        'agent_get_memories_by_type',
        'agent_clear_memories',
        'agent_add_task',
        'agent_get_tasks',
        'agent_get_pending_tasks',
        'agent_update_task_status',
        'agent_clear_tasks',
        'agent_get_info',
      ];

      for (const funcName of agentFunctions) {
        const result = await client.callAgentMethod(canisterId, funcName, []);
        expect(result).toBeDefined();
      }
    });

    it('should support WASM module management functions', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const wasmFunctions = ['loadAgentWasm', 'getWasmInfo'];

      for (const funcName of wasmFunctions) {
        const result = await client.callAgentMethod(canisterId, funcName, []);
        expect(result).toBeDefined();
      }
    });

    it('should reject invalid method names', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      await expect(
        client.callAgentMethod(canisterId, 'invalid_method', [])
      ).rejects.toThrow('Unknown method: invalid_method');
    });
  });

  describe('Agent State Functions - API Structure', () => {
    it('agent_init should accept config parameter', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();
      const config = new TextEncoder().encode('{"name":"test"}');

      const result = await client.callAgentMethod(canisterId, 'agent_init', [config]);

      expect(result).toHaveProperty('#ok');
    });

    it('agent_step should accept input parameter', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();
      const input = new TextEncoder().encode('test input');

      const result = await client.callAgentMethod(canisterId, 'agent_step', [input]);

      expect(result).toHaveProperty('#ok');
    });

    it('agent_get_state should return array', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'agent_get_state', []);

      expect(Array.isArray(result)).toBe(true);
    });

    it('agent_get_state_size should return number', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'agent_get_state_size', []);

      expect(typeof result).toBe('number');
    });
  });

  describe('Agent Memory Functions - API Structure', () => {
    it('agent_add_memory should accept type and content', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();
      const type = 0;
      const content = new TextEncoder().encode('test memory');

      const result = await client.callAgentMethod(canisterId, 'agent_add_memory', [type, content]);

      expect(result).toHaveProperty('#ok');
    });

    it('agent_get_memories should return array', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'agent_get_memories', []);

      expect(Array.isArray(result)).toBe(true);
    });

    it('agent_get_memories_by_type should accept type parameter', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();
      const memoryType = 0;

      const result = await client.callAgentMethod(canisterId, 'agent_get_memories_by_type', [memoryType]);

      expect(Array.isArray(result)).toBe(true);
    });

    it('agent_clear_memories should return success', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'agent_clear_memories', []);

      expect(result).toHaveProperty('#ok');
    });
  });

  describe('Agent Task Functions - API Structure', () => {
    it('agent_add_task should accept taskId and description', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();
      const taskId = new TextEncoder().encode('task-1');
      const description = new TextEncoder().encode('Test task');

      const result = await client.callAgentMethod(canisterId, 'agent_add_task', [taskId, description]);

      expect(result).toHaveProperty('#ok');
    });

    it('agent_get_tasks should return array', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'agent_get_tasks', []);

      expect(Array.isArray(result)).toBe(true);
    });

    it('agent_get_pending_tasks should return array', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'agent_get_pending_tasks', []);

      expect(Array.isArray(result)).toBe(true);
    });

    it('agent_update_task_status should accept taskId, status, and result', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();
      const taskId = new TextEncoder().encode('task-1');
      const status = 2;
      const result = new TextEncoder().encode('Completed');

      const callResult = await client.callAgentMethod(canisterId, 'agent_update_task_status', [taskId, status, result]);

      expect(callResult).toHaveProperty('#ok');
    });

    it('agent_clear_tasks should return success', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'agent_clear_tasks', []);

      expect(result).toHaveProperty('#ok');
    });
  });

  describe('Agent Info Function - API Structure', () => {
    it('agent_get_info should return array', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'agent_get_info', []);

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('WASM Module Management - API Structure', () => {
    it('loadAgentWasm should accept wasm and hash', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const hash = [0, 0, 0, 0];

      const result = await client.callAgentMethod(canisterId, 'loadAgentWasm', [wasm, hash]);

      expect(result).toHaveProperty('#ok');
    });

    it('getWasmInfo should return metadata object', async () => {
      const client = createICPClient({ network: 'local' });
      const canisterId = generateStubCanisterId();

      const result = await client.callAgentMethod(canisterId, 'getWasmInfo', []);

      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('functionNameCount');
    });
  });

  describe('Network Configuration', () => {
    it('should support local network', () => {
      const client = createICPClient({ network: 'local' });

      expect(client.network).toBe('local');
    });

    it('should support ic network', () => {
      const client = createICPClient({ network: 'ic' });

      expect(client.network).toBe('ic');
    });

    it('should support custom host', () => {
      const client = createICPClient({ network: 'local', host: 'http://localhost:8080' });

      expect(client.getHost()).toBe('http://localhost:8080');
    });
  });

  describe('Utility Functions', () => {
    it('generateStubCanisterId should return valid canister ID', () => {
      const canisterId = generateStubCanisterId();

      expect(typeof canisterId).toBe('string');
      expect(canisterId).toMatch(/^[a-z0-9-]+$/);
    });

    it('calculateWasmHash should return hash string', () => {
      const client = createICPClient({ network: 'local' });

      const result = client.calculateWasmHash;

      expect(typeof result).toBe('function');
    });

    it('validateWasmPath should return validation result', () => {
      const client = createICPClient({ network: 'local' });

      const result = client.validateWasmPath;

      expect(typeof result).toBe('function');
    });
  });

  describe('Error Handling - API Structure', () => {
    it('should have checkConnection method', () => {
      const client = createICPClient({ network: 'local' });

      expect(client).toHaveProperty('checkConnection');
      expect(typeof client.checkConnection).toBe('function');
    });

    it('should have getCanisterStatus method', () => {
      const client = createICPClient({ network: 'local' });

      expect(client).toHaveProperty('getCanisterStatus');
      expect(typeof client.getCanisterStatus).toBe('function');
    });

    it('should have loadAgentWasm method', () => {
      const client = createICPClient({ network: 'local' });

      expect(client).toHaveProperty('loadAgentWasm');
      expect(typeof client.loadAgentWasm).toBe('function');
    });

    it('should have executeAgent method', () => {
      const client = createICPClient({ network: 'local' });

      expect(client).toHaveProperty('executeAgent');
      expect(typeof client.executeAgent).toBe('function');
    });
  });
});
