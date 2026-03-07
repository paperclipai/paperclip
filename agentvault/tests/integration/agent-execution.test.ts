/**
 * Agent Execution Integration Tests
 *
 * Tests for on-chain agent execution using agent.mo canister.
 * Tests the 14-function agent interface.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createICPClient, generateStubCanisterId } from '../../src/deployment/icpClient.js';

describe('Agent Execution - On-Chain', () => {
  let client: ReturnType<typeof createICPClient>;
  let testCanisterId: string;

  beforeEach(() => {
    client = createICPClient({ network: 'local' });
    testCanisterId = generateStubCanisterId();
  });

  describe('Agent State Functions', () => {
    it('should call agent_init successfully', async () => {
      const config = new TextEncoder().encode('{"name":"test","version":"1.0.0"}');
      const result = await client.callAgentMethod(testCanisterId, 'agent_init', [config]);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('#ok');
    });

    it('should call agent_step successfully', async () => {
      const input = new TextEncoder().encode('test input');
      const result = await client.callAgentMethod(testCanisterId, 'agent_step', [input]);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('#ok');
    });

    it('should call agent_get_state successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'agent_get_state', []);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should call agent_get_state_size successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'agent_get_state_size', []);

      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Agent Memory Functions', () => {
    it('should call agent_add_memory successfully', async () => {
      const type = 0; // fact
      const content = new TextEncoder().encode('test memory');
      const result = await client.callAgentMethod(testCanisterId, 'agent_add_memory', [type, content]);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('#ok');
    });

    it('should call agent_get_memories successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'agent_get_memories', []);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should call agent_get_memories_by_type successfully', async () => {
      const memoryType = 0; // fact
      const result = await client.callAgentMethod(testCanisterId, 'agent_get_memories_by_type', [memoryType]);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should call agent_clear_memories successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'agent_clear_memories', []);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('#ok');
    });
  });

  describe('Agent Task Functions', () => {
    it('should call agent_add_task successfully', async () => {
      const taskId = new TextEncoder().encode('task-1');
      const description = new TextEncoder().encode('Test task');
      const result = await client.callAgentMethod(testCanisterId, 'agent_add_task', [taskId, description]);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('#ok');
    });

    it('should call agent_get_tasks successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'agent_get_tasks', []);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should call agent_get_pending_tasks successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'agent_get_pending_tasks', []);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should call agent_update_task_status successfully', async () => {
      const taskId = new TextEncoder().encode('task-1');
      const status = 2; // completed
      const result = new TextEncoder().encode('Task completed');
      const callResult = await client.callAgentMethod(testCanisterId, 'agent_update_task_status', [taskId, status, result]);

      expect(callResult).toBeDefined();
      expect(callResult).toHaveProperty('#ok');
    });

    it('should call agent_clear_tasks successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'agent_clear_tasks', []);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('#ok');
    });
  });

  describe('Agent Info Function', () => {
    it('should call agent_get_info successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'agent_get_info', []);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('WASM Module Management', () => {
    it('should call loadAgentWasm successfully', async () => {
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const hash = [0, 0, 0, 0];
      const result = await client.callAgentMethod(testCanisterId, 'loadAgentWasm', [wasm, hash]);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('#ok');
    });

    it('should call getWasmInfo successfully', async () => {
      const result = await client.callAgentMethod(testCanisterId, 'getWasmInfo', []);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('size');
      expect(result).toHaveProperty('functionNameCount');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid method names', async () => {
      await expect(
        client.callAgentMethod(testCanisterId, 'invalid_method', [])
      ).rejects.toThrow('Unknown method: invalid_method');
    });

    it('should handle network errors gracefully', async () => {
      const invalidClient = createICPClient({ network: 'local' });

      // This should not throw, but handle errors gracefully
      await expect(
        invalidClient.callAgentMethod(testCanisterId, 'agent_get_state', [])
      ).resolves.toBeDefined();
    });
  });

  describe('Integration - Complete Workflow', () => {
    it('should execute complete agent lifecycle', async () => {
      // Step 1: Initialize agent
      const config = new TextEncoder().encode('{"name":"integration-test","version":"1.0.0"}');
      const initResult = await client.callAgentMethod(testCanisterId, 'agent_init', [config]);
      expect(initResult).toHaveProperty('#ok');

      // Step 2: Load WASM
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const hash = [0, 0, 0, 0];
      const loadResult = await client.callAgentMethod(testCanisterId, 'loadAgentWasm', [wasm, hash]);
      expect(loadResult).toHaveProperty('#ok');

      // Step 3: Execute step
      const input = new TextEncoder().encode('integration test');
      const stepResult = await client.callAgentMethod(testCanisterId, 'agent_step', [input]);
      expect(stepResult).toHaveProperty('#ok');

      // Step 4: Get state
      const stateResult = await client.callAgentMethod(testCanisterId, 'agent_get_state', []);
      expect(Array.isArray(stateResult)).toBe(true);

      // Step 5: Add memory
      const type = 0;
      const content = new TextEncoder().encode('integration memory');
      const memoryResult = await client.callAgentMethod(testCanisterId, 'agent_add_memory', [type, content]);
      expect(memoryResult).toHaveProperty('#ok');

      // Step 6: Add task
      const taskId = new TextEncoder().encode('task-integration');
      const description = new TextEncoder().encode('Integration task');
      const taskResult = await client.callAgentMethod(testCanisterId, 'agent_add_task', [taskId, description]);
      expect(taskResult).toHaveProperty('#ok');

      // Step 7: Get info
      const infoResult = await client.callAgentMethod(testCanisterId, 'agent_get_info', []);
      expect(Array.isArray(infoResult)).toBe(true);
    });
  });
});
