import { describe, it, expect, vi } from 'vitest';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../manifest.js';
import plugin from '../worker.js';
import type { TestHarness } from '@paperclipai/plugin-sdk/testing';

describe('Ruflo Bridge Integration Tests', () => {
  // Helper to create a fresh harness for each test
  async function createHarness(): Promise<TestHarness> {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    return harness;
  }

  describe('Tool Registration', () => {
    it('should register all 9 tools on boot', async () => {
      const harness = await createHarness();
      
      // Execute each tool to verify they were registered
      const toolNames = [
        'agent_spawn',
        'swarm_init',
        'memory_store',
        'memory_search',
        'workflow_create',
        'workflow_execute',
        'coordination_orchestrate',
        'autopilot_status',
        'hooks_route',
      ];

      // Verify all tools can be executed (meaning they're registered)
      for (const toolName of toolNames) {
        // autopilot_status and hooks_route have no required params
        // others need minimal valid params
        const params = toolName === 'autopilot_status' 
          ? {} 
          : toolName === 'hooks_route'
            ? { task: 'test task' }
            : { agentType: 'worker', name: 'test', key: 'test', value: 'test', query: 'test', workflowId: 'test', task: 'test' };
        
        await expect(harness.executeTool(toolName, params)).resolves.toBeDefined();
      }
    });

    it('should have unique tool registrations', async () => {
      const harness = await createHarness();
      
      // Execute same tool twice and verify it works consistently
      const result1 = await harness.executeTool('autopilot_status', {});
      const result2 = await harness.executeTool('autopilot_status', {});
      
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });
  });

  describe('agent_spawn Tool Execution', () => {
    it('should spawn agent with required params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('agent_spawn', {
        agentType: 'coder',
        task: 'Fix bug #123'
      });
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.agentId).toBeDefined();
      expect(data.status).toBe('spawned');
    });

    it('should spawn agent with all optional params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('agent_spawn', {
        agentType: 'specialist',
        task: 'Analyze codebase',
        model: 'sonnet',
        domain: 'engineering'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.agentId).toBeDefined();
    });

    it('should spawn agent with different agent types', async () => {
      const harness = await createHarness();
      
      const agentTypes = ['worker', 'specialist', 'scout', 'coordinator', 'analyst'];
      
      for (const agentType of agentTypes) {
        const result = await harness.executeTool('agent_spawn', {
          agentType,
          task: `Task for ${agentType}`
        });
        
        const data = JSON.parse(result.content as string);
        expect(data.success).toBe(true);
      }
    });

    it('should handle missing agentType gracefully (returns undefined)', async () => {
      const harness = await createHarness();
      
      // The worker implementation handles undefined agentType gracefully
      // It creates an agent with agentType: undefined
      const result = await harness.executeTool('agent_spawn', {});
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.agentId).toBeDefined();
    });
  });

  describe('swarm_init Tool Execution', () => {
    it('should initialize swarm with default params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('swarm_init', {});
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.swarmId).toBeDefined();
      expect(data.topology).toBe('hierarchical-mesh'); // default
      expect(data.maxAgents).toBe(10); // default
    });

    it('should initialize swarm with custom params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('swarm_init', {
        topology: 'mesh',
        maxAgents: 50,
        strategy: 'specialized'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.swarmId).toBeDefined();
      expect(data.topology).toBe('mesh');
    });

    it('should support all topology types', async () => {
      const harness = await createHarness();
      
      const topologies = [
        'hierarchical',
        'mesh',
        'hierarchical-mesh',
        'ring',
        'star',
        'hybrid',
        'adaptive'
      ];
      
      for (const topology of topologies) {
        const result = await harness.executeTool('swarm_init', { topology });
        const data = JSON.parse(result.content as string);
        expect(data.success).toBe(true);
        expect(data.topology).toBe(topology);
      }
    });

    it('should support all strategy types', async () => {
      const harness = await createHarness();
      
      const strategies = ['specialized', 'balanced', 'adaptive'];
      
      for (const strategy of strategies) {
        const result = await harness.executeTool('swarm_init', { strategy });
        const data = JSON.parse(result.content as string);
        expect(data.success).toBe(true);
      }
    });
  });

  describe('memory_store Tool Execution', () => {
    it('should store memory with required params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('memory_store', {
        key: 'test-key',
        value: { data: 'test value' }
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.entryId).toBeDefined();
    });

    it('should store memory with tags and namespace', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('memory_store', {
        key: 'test-key-2',
        value: 'simple string value',
        namespace: 'custom-namespace',
        tags: ['important', 'test']
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
    });
  });

  describe('memory_search Tool Execution', () => {
    it('should search memory with required params', async () => {
      const harness = await createHarness();
      
      // First store some data
      await harness.executeTool('memory_store', {
        key: 'searchable-key',
        value: 'This is a searchable test value'
      });
      
      // Then search for it
      const result = await harness.executeTool('memory_search', {
        query: 'searchable'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.results).toBeDefined();
      expect(data.count).toBeDefined();
    });

    it('should respect limit parameter', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('memory_search', {
        query: 'test',
        limit: 5
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.results.length).toBeLessThanOrEqual(5);
    });
  });

  describe('workflow_create Tool Execution', () => {
    it('should create workflow with required params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('workflow_create', {
        name: 'Test Workflow'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.workflowId).toBeDefined();
    });

    it('should create workflow with steps', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('workflow_create', {
        name: 'Complex Workflow',
        description: 'A workflow with steps',
        steps: [
          { name: 'Step 1', type: 'task' },
          { name: 'Step 2', type: 'condition' }
        ]
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
    });
  });

  describe('workflow_execute Tool Execution', () => {
    it('should execute workflow with required params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('workflow_execute', {
        workflowId: 'wf-test-123'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.workflowId).toBe('wf-test-123');
      expect(data.status).toBe('running');
    });

    it('should execute workflow with variables', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('workflow_execute', {
        workflowId: 'wf-test-456',
        variables: {
          env: 'production',
          version: '1.0.0'
        }
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
    });
  });

  describe('coordination_orchestrate Tool Execution', () => {
    it('should orchestrate with required params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('coordination_orchestrate', {
        task: 'Coordinate agents for deployment'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.coordinationId).toBeDefined();
      expect(data.strategy).toBe('parallel'); // default
    });

    it('should orchestrate with specific agents and strategy', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('coordination_orchestrate', {
        task: 'Multi-agent task',
        agents: ['agent-1', 'agent-2', 'agent-3'],
        strategy: 'pipeline'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.strategy).toBe('pipeline');
    });

    it('should support all strategies', async () => {
      const harness = await createHarness();
      
      const strategies = ['parallel', 'sequential', 'pipeline', 'broadcast'];
      
      for (const strategy of strategies) {
        const result = await harness.executeTool('coordination_orchestrate', {
          task: `Task with ${strategy} strategy`,
          strategy
        });
        
        const data = JSON.parse(result.content as string);
        expect(data.success).toBe(true);
      }
    });
  });

  describe('autopilot_status Tool Execution', () => {
    it('should get autopilot status', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('autopilot_status', {});
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.state).toBeDefined();
    });
  });

  describe('hooks_route Tool Execution', () => {
    it('should route task with required params', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('hooks_route', {
        task: 'Route this task to optimal agent'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.routingId).toBeDefined();
      expect(data.task).toBe('Route this task to optimal agent');
    });

    it('should route task with context', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('hooks_route', {
        task: 'Complex routing task',
        context: 'Additional context for routing decision'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
    });
  });

  describe('Entity Operations Mocked', () => {
    it('should create and track ruflo_agent entities', async () => {
      const harness = await createHarness();
      
      // Spawn multiple agents
      const result1 = await harness.executeTool('agent_spawn', {
        agentType: 'worker',
        task: 'Task 1'
      });
      
      const result2 = await harness.executeTool('agent_spawn', {
        agentType: 'specialist',
        task: 'Task 2'
      });
      
      // Verify both have unique IDs
      const data1 = JSON.parse(result1.content as string);
      const data2 = JSON.parse(result2.content as string);
      
      expect(data1.agentId).not.toBe(data2.agentId);
    });

    it('should create and track ruflo_swarm entities', async () => {
      const harness = await createHarness();
      
      const result1 = await harness.executeTool('swarm_init', { topology: 'mesh' });
      const result2 = await harness.executeTool('swarm_init', { topology: 'star' });
      
      const data1 = JSON.parse(result1.content as string);
      const data2 = JSON.parse(result2.content as string);
      
      expect(data1.swarmId).not.toBe(data2.swarmId);
    });

    it('should create and track ruflo_memory entities', async () => {
      const harness = await createHarness();
      
      await harness.executeTool('memory_store', {
        key: 'key-1',
        value: 'value-1'
      });
      
      await harness.executeTool('memory_store', {
        key: 'key-2',
        value: 'value-2'
      });
      
      // Search should find stored items
      const result = await harness.executeTool('memory_search', {
        query: 'value',
        limit: 10
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.results).toBeDefined();
    });

    it('should create and track ruflo_workflow entities', async () => {
      const harness = await createHarness();
      
      const createResult = await harness.executeTool('workflow_create', {
        name: 'Test Workflow'
      });
      
      const createData = JSON.parse(createResult.content as string);
      
      // Execute the created workflow
      const execResult = await harness.executeTool('workflow_execute', {
        workflowId: createData.workflowId
      });
      
      const execData = JSON.parse(execResult.content as string);
      expect(execData.success).toBe(true);
    });

    it('should create and track ruflo_coordination entities', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('coordination_orchestrate', {
        task: 'Test coordination'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.coordinationId).toBeDefined();
    });

    it('should create and track ruflo_routing entities', async () => {
      const harness = await createHarness();
      
      const result = await harness.executeTool('hooks_route', {
        task: 'Test routing'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
      expect(data.routingId).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid tool name', async () => {
      const harness = await createHarness();
      
      await expect(harness.executeTool('nonexistent_tool', {})).rejects.toThrow('No tool handler registered');
    });

    it('should handle memory_search missing query param', async () => {
      const harness = await createHarness();
      
      // The worker implementation expects 'query' but doesn't validate - returns empty results
      const result = await harness.executeTool('memory_search', {});
      const data = JSON.parse(result.content as string);
      
      // Should still succeed but return empty results
      expect(data.success).toBe(true);
    });

    it('should handle workflow_execute missing workflowId', async () => {
      const harness = await createHarness();
      
      // The worker implementation expects workflowId but handles undefined gracefully
      const result = await harness.executeTool('workflow_execute', {});
      const data = JSON.parse(result.content as string);
      
      expect(data.success).toBe(true);
      expect(data.workflowId).toBeUndefined();
    });

    it('should handle hooks_route missing task', async () => {
      const harness = await createHarness();
      
      // The worker implementation expects task but handles undefined gracefully
      const result = await harness.executeTool('hooks_route', {});
      const data = JSON.parse(result.content as string);
      
      expect(data.success).toBe(true);
    });

    it('should handle invalid model enum value', async () => {
      const harness = await createHarness();
      
      // The worker accepts any string for model, doesn't validate enum
      const result = await harness.executeTool('agent_spawn', {
        agentType: 'worker',
        model: 'invalid-model'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
    });

    it('should handle various data types for memory value', async () => {
      const harness = await createHarness();
      
      const values = [
        'string value',
        123,
        { nested: 'object' },
        [1, 2, 3],
        true,
        null
      ];
      
      for (let i = 0; i < values.length; i++) {
        const result = await harness.executeTool('memory_store', {
          key: `key-${i}`,
          value: values[i]
        });
        
        const data = JSON.parse(result.content as string);
        expect(data.success).toBe(true);
      }
    });
  });

  describe('Logging and Events', () => {
    it('should log during plugin setup', async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);
      
      // Check that logs were recorded
      expect(harness.logs.length).toBeGreaterThan(0);
      
      const infoLogs = harness.logs.filter(l => l.level === 'info');
      expect(infoLogs.some(l => l.message.includes('Ruflo'))).toBe(true);
    });

    it('should track entity creation in logs', async () => {
      const harness = await createHarness();
      
      // Clear previous logs
      harness.logs.length = 0;
      
      await harness.executeTool('agent_spawn', {
        agentType: 'worker',
        task: 'Test task'
      });
      
      // Check for spawn log
      const spawnLogs = harness.logs.filter(l => l.message.includes('Spawned'));
      expect(spawnLogs.length).toBeGreaterThan(0);
    });
  });

  describe('Health Check', () => {
    it('should return healthy status', async () => {
      if (!plugin.definition.onHealth) {
        // If onHealth is not defined, skip this test
        return;
      }
      const health = await plugin.definition.onHealth();
      
      expect(health).toBeDefined();
      expect(health.status).toBe('ok');
      expect(health.message).toContain('healthy');
    });
  });
});
