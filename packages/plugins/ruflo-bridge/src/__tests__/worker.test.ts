import { describe, it, expect } from 'vitest';
import manifest from '../manifest';

describe('Ruflo MCP Bridge Plugin', () => {
  describe('manifest validation', () => {
    it('should have valid manifest structure', () => {
      expect(manifest.id).toBe('ruflo.bridge');
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.tools).toBeDefined();
      expect(Array.isArray(manifest.tools)).toBe(true);
    });

    it('should declare all 9 Ruflo orchestration tools', () => {
      const expectedTools = [
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

      const declaredTools = manifest.tools!.map((t) => t.name);

      expectedTools.forEach((tool) => {
        expect(declaredTools).toContain(tool);
      });

      expect(declaredTools).toHaveLength(9);
    });

    it('should have unique tool names', () => {
      const names = manifest.tools!.map((t) => t.name);
      const unique = new Set(names);
      expect(names.length).toBe(unique.size);
    });

    it('should have valid tool schemas', () => {
      manifest.tools!.forEach((tool) => {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.parametersSchema).toBeDefined();
        expect(typeof tool.parametersSchema).toBe('object');
      });
    });
  });

  describe('agent_spawn tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'agent_spawn');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have correct required fields', () => {
      expect(tool!.parametersSchema.required).toContain('agentType');
    });

    it('should have agentType property', () => {
      expect(tool!.parametersSchema.properties.agentType).toBeDefined();
      expect(tool!.parametersSchema.properties.agentType.type).toBe('string');
    });

    it('should have optional task property', () => {
      expect(tool!.parametersSchema.properties.task).toBeDefined();
      expect(tool!.parametersSchema.properties.task.type).toBe('string');
    });

    it('should have model enum with correct values', () => {
      const model = tool!.parametersSchema.properties.model;
      expect(model).toBeDefined();
      expect(model.enum).toEqual(['haiku', 'sonnet', 'opus', 'inherit']);
      expect(model.default).toBe('inherit');
    });

    it('should have optional domain property', () => {
      expect(tool!.parametersSchema.properties.domain).toBeDefined();
      expect(tool!.parametersSchema.properties.domain.type).toBe('string');
    });
  });

  describe('swarm_init tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'swarm_init');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have topology enum with correct values', () => {
      const topology = tool!.parametersSchema.properties.topology;
      expect(topology).toBeDefined();
      expect(topology.enum).toEqual([
        'hierarchical',
        'mesh',
        'hierarchical-mesh',
        'ring',
        'star',
        'hybrid',
        'adaptive',
      ]);
      expect(topology.default).toBe('hierarchical-mesh');
    });

    it('should have maxAgents property with default', () => {
      const maxAgents = tool!.parametersSchema.properties.maxAgents;
      expect(maxAgents).toBeDefined();
      expect(maxAgents.type).toBe('number');
      expect(maxAgents.default).toBe(10);
    });

    it('should have strategy enum with correct values', () => {
      const strategy = tool!.parametersSchema.properties.strategy;
      expect(strategy).toBeDefined();
      expect(strategy.enum).toEqual(['specialized', 'balanced', 'adaptive']);
      expect(strategy.default).toBe('adaptive');
    });
  });

  describe('memory_store tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'memory_store');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required key and value fields', () => {
      expect(tool!.parametersSchema.required).toContain('key');
      expect(tool!.parametersSchema.required).toContain('value');
    });

    it('should have key property', () => {
      expect(tool!.parametersSchema.properties.key).toBeDefined();
      expect(tool!.parametersSchema.properties.key.type).toBe('string');
    });

    it('should have value property (any type)', () => {
      expect(tool!.parametersSchema.properties.value).toBeDefined();
    });

    it('should have namespace with default', () => {
      const namespace = tool!.parametersSchema.properties.namespace;
      expect(namespace).toBeDefined();
      expect(namespace.type).toBe('string');
      expect(namespace.default).toBe('paperclip');
    });

    it('should have tags array', () => {
      const tags = tool!.parametersSchema.properties.tags;
      expect(tags).toBeDefined();
      expect(tags.type).toBe('array');
      expect(tags.items.type).toBe('string');
    });
  });

  describe('memory_search tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'memory_search');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required query field', () => {
      expect(tool!.parametersSchema.required).toContain('query');
    });

    it('should have query property', () => {
      expect(tool!.parametersSchema.properties.query).toBeDefined();
      expect(tool!.parametersSchema.properties.query.type).toBe('string');
    });

    it('should have namespace with default', () => {
      const namespace = tool!.parametersSchema.properties.namespace;
      expect(namespace).toBeDefined();
      expect(namespace.type).toBe('string');
      expect(namespace.default).toBe('paperclip');
    });

    it('should have limit with default', () => {
      const limit = tool!.parametersSchema.properties.limit;
      expect(limit).toBeDefined();
      expect(limit.type).toBe('number');
      expect(limit.default).toBe(10);
    });
  });

  describe('workflow_create tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'workflow_create');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required name field', () => {
      expect(tool!.parametersSchema.required).toContain('name');
    });

    it('should have name property', () => {
      expect(tool!.parametersSchema.properties.name).toBeDefined();
      expect(tool!.parametersSchema.properties.name.type).toBe('string');
    });

    it('should have optional description', () => {
      expect(tool!.parametersSchema.properties.description).toBeDefined();
      expect(tool!.parametersSchema.properties.description.type).toBe('string');
    });

    it('should have optional steps array', () => {
      const steps = tool!.parametersSchema.properties.steps;
      expect(steps).toBeDefined();
      expect(steps.type).toBe('array');
    });
  });

  describe('workflow_execute tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'workflow_execute');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required workflowId field', () => {
      expect(tool!.parametersSchema.required).toContain('workflowId');
    });

    it('should have workflowId property', () => {
      expect(tool!.parametersSchema.properties.workflowId).toBeDefined();
      expect(tool!.parametersSchema.properties.workflowId.type).toBe('string');
    });

    it('should have optional variables object', () => {
      const variables = tool!.parametersSchema.properties.variables;
      expect(variables).toBeDefined();
      expect(variables.type).toBe('object');
    });
  });

  describe('coordination_orchestrate tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'coordination_orchestrate');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required task field', () => {
      expect(tool!.parametersSchema.required).toContain('task');
    });

    it('should have task property', () => {
      expect(tool!.parametersSchema.properties.task).toBeDefined();
      expect(tool!.parametersSchema.properties.task.type).toBe('string');
    });

    it('should have optional agents array', () => {
      const agents = tool!.parametersSchema.properties.agents;
      expect(agents).toBeDefined();
      expect(agents.type).toBe('array');
      expect(agents.items.type).toBe('string');
    });

    it('should have strategy enum with correct values', () => {
      const strategy = tool!.parametersSchema.properties.strategy;
      expect(strategy).toBeDefined();
      expect(strategy.enum).toEqual(['parallel', 'sequential', 'pipeline', 'broadcast']);
      expect(strategy.default).toBe('parallel');
    });
  });

  describe('autopilot_status tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'autopilot_status');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have no required fields', () => {
      expect(tool!.parametersSchema.required).toBeUndefined();
      expect(Object.keys(tool!.parametersSchema.properties || {})).toHaveLength(0);
    });
  });

  describe('hooks_route tool schema', () => {
    const tool = manifest.tools!.find((t) => t.name === 'hooks_route');

    it('should exist', () => {
      expect(tool).toBeDefined();
    });

    it('should have required task field', () => {
      expect(tool!.parametersSchema.required).toContain('task');
    });

    it('should have task property', () => {
      expect(tool!.parametersSchema.properties.task).toBeDefined();
      expect(tool!.parametersSchema.properties.task.type).toBe('string');
    });

    it('should have optional context', () => {
      expect(tool!.parametersSchema.properties.context).toBeDefined();
      expect(tool!.parametersSchema.properties.context.type).toBe('string');
    });
  });

  describe('Tool description quality', () => {
    it('should have descriptive descriptions for all tools', () => {
      manifest.tools!.forEach((tool) => {
        expect(tool.description.length).toBeGreaterThan(10);
        expect(tool.description).not.toMatch(/^(foo|bar|test|placeholder)/i);
      });
    });

    it('should have consistent naming convention', () => {
      manifest.tools!.forEach((tool) => {
        expect(tool.name).toMatch(/^[a-z_]+$/);
        expect(tool.name).not.toMatch(/^[A-Z]/);
        expect(tool.name).not.toMatch(/-/);
      });
    });
  });
});
