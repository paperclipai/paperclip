import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../manifest.js';
import plugin from '../worker.js';
import type { TestHarness } from '@paperclipai/plugin-sdk/testing';

// Mock global fetch for Skills Hub API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock skill object factory
function mockSkill(overrides = {}) {
  return {
    id: 1,
    repo_name: 'test-skill',
    repo_full_name: 'user/test-skill',
    description: 'Test skill',
    stars: 100,
    score: 0.9,
    category: 'devops',
    language: 'TypeScript',
    repo_url: 'https://github.com/user/test-skill',
    ...overrides,
  };
}

describe('Skills Hub Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // Helper to create a fresh harness for each test
  async function createHarness(): Promise<TestHarness> {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    return harness;
  }

  describe('Tool Registration', () => {
    it('should register all 12 tools on boot', async () => {
      const harness = await createHarness();
      
      const toolNames = [
        'search_skills',
        'get_skill',
        'get_trending',
        'get_top_rated',
        'get_rising',
        'get_categories',
        'get_masters',
        'get_stats',
        'submit_skill',
        'scan_security',
        'get_workflows',
        'get_landing',
      ];

      // Mock responses based on endpoint type
      for (const toolName of toolNames) {
        if (toolName === 'search_skills') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ items: [mockSkill()], total: 1, page: 1 }),
          });
        } else if (['get_trending', 'get_top_rated', 'get_rising'].includes(toolName)) {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [mockSkill()],
          });
        } else if (toolName === 'get_skill') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => mockSkill(),
          });
        } else if (toolName === 'get_categories') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ id: 'test', name: 'Test', count: 10 }],
          });
        } else if (toolName === 'get_masters') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ id: 'master-1', name: 'Master Skill' }],
          });
        } else if (toolName === 'get_stats') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ total_skills: 100, total_downloads: 1000 }),
          });
        } else if (toolName === 'submit_skill') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, skill_id: 999 }),
          });
        } else if (toolName === 'scan_security') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ threats: [], pii_detected: false, safe: true }),
          });
        } else if (toolName === 'get_workflows') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ id: 'wf-1', name: 'Test Workflow' }],
          });
        } else if (toolName === 'get_landing') {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ featured: [], trending: [], stats: {} }),
          });
        }

        const params: Record<string, any> = {};
        if (toolName === 'search_skills') params.query = 'test';
        if (toolName === 'get_skill') params.skill_id = 1;
        if (toolName === 'submit_skill') {
          params.name = 'test';
          params.description = 'test';
          params.content = 'test';
        }
        if (toolName === 'scan_security') params.content = 'test';
        
        await expect(harness.executeTool(toolName, params)).resolves.toBeDefined();
      }
    });

    it('should have unique tool registrations', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ total_skills: 100 }),
      });
      
      const result1 = await harness.executeTool('get_stats', {});
      const result2 = await harness.executeTool('get_stats', {});
      
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });
  });

  describe('search_skills Tool Execution', () => {
    it('should search skills with query', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [mockSkill({ repo_name: 'autonomous-mission' })],
          total: 1,
          page: 1,
        }),
      });
      
      const result = await harness.executeTool('search_skills', {
        query: 'autonomous-mission'
      });
      
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data.skills)).toBe(true);
      expect(data.skills.length).toBe(1);
    });

    it('should search with category filter', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1 }),
      });
      
      const result = await harness.executeTool('search_skills', {
        query: 'mining',
        category: 'crypto-operations'
      });
      
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('category=crypto-operations');
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data.skills)).toBe(true);
    });

    it('should search with limit param', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1 }),
      });
      
      const result = await harness.executeTool('search_skills', {
        query: 'test',
        limit: 50
      });
      
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('page_size=50');
    });
  });

  describe('get_skill Tool Execution', () => {
    it('should get skill by ID', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockSkill({
          repo_name: 'mining-phase-gated-research',
          quality_completeness: 0.9,
          quality_clarity: 0.95,
        }),
      });
      
      const result = await harness.executeTool('get_skill', {
        skill_id: 123
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.name).toBe('mining-phase-gated-research');
      expect(data.quality).toBeDefined();
    });

    it('should handle API error gracefully', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });
      
      await expect(
        harness.executeTool('get_skill', { skill_id: 999 })
      ).rejects.toThrow('Skills Hub API error: 404');
    });
  });

  describe('get_trending Tool Execution', () => {
    it('should get trending skills', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          mockSkill({ repo_name: 'trending-1', stars: 200 }),
          mockSkill({ repo_name: 'trending-2', stars: 180 }),
        ],
      });
      
      const result = await harness.executeTool('get_trending', {});
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('should get trending with limit', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [mockSkill()],
      });
      
      const result = await harness.executeTool('get_trending', {
        limit: 5
      });
      
      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain('limit=5');
    });
  });

  describe('get_top_rated Tool Execution', () => {
    it('should get top rated skills', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [mockSkill({ score: 0.98 })],
      });
      
      const result = await harness.executeTool('get_top_rated', {});
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('get_rising Tool Execution', () => {
    it('should get rising skills', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [mockSkill()],
      });
      
      const result = await harness.executeTool('get_rising', {});
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('get_categories Tool Execution', () => {
    it('should get all categories', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'devops', name: 'DevOps', count: 45 },
          { id: 'mlops', name: 'MLOps', count: 32 },
        ],
      });
      
      const result = await harness.executeTool('get_categories', {});
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });
  });

  describe('get_masters Tool Execution', () => {
    it('should get master skills', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [{ id: 'master-1', name: 'Master Skill' }],
      });
      
      const result = await harness.executeTool('get_masters', {});
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('get_stats Tool Execution', () => {
    it('should get platform stats', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          total_skills: 150,
          total_downloads: 5000,
          total_categories: 12,
        }),
      });
      
      const result = await harness.executeTool('get_stats', {});
      
      const data = JSON.parse(result.content as string);
      expect(data.total_skills).toBe(150);
    });
  });

  describe('submit_skill Tool Execution', () => {
    it('should submit skill with required params', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          skill_id: 999,
          message: 'Skill submitted successfully',
        }),
      });
      
      const result = await harness.executeTool('submit_skill', {
        name: 'test-submission',
        description: 'Test skill for integration testing',
        content: '# Test Skill\n\nTest content'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
    });

    it('should submit skill with optional metadata', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, skill_id: 999 }),
      });
      
      const result = await harness.executeTool('submit_skill', {
        name: 'test-with-metadata',
        description: 'Test with metadata',
        content: '# Test\n\nContent',
        category: 'software-development',
        tags: ['test', 'integration']
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.success).toBe(true);
    });
  });

  describe('scan_security Tool Execution', () => {
    it('should scan content for security issues', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          threats: [],
          pii_detected: false,
          safe: true,
        }),
      });
      
      const result = await harness.executeTool('scan_security', {
        content: 'console.log("test");'
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.safe).toBe(true);
    });

    it('should detect PII when enabled', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          threats: [],
          pii_detected: true,
          pii_items: ['email', 'api_key'],
          safe: false,
        }),
      });
      
      const result = await harness.executeTool('scan_security', {
        content: 'test@example.com',
        detectPii: true
      });
      
      const data = JSON.parse(result.content as string);
      expect(data.pii_detected).toBe(true);
    });
  });

  describe('get_workflows Tool Execution', () => {
    it('should get workflows', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 'github-pr', name: 'GitHub PR Workflow' },
          { id: 'bugfix', name: 'Bugfix Workflow' },
        ],
      });
      
      const result = await harness.executeTool('get_workflows', {});
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });

    it('should get workflows with category filter', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      
      const result = await harness.executeTool('get_workflows', {
        category: 'github-pr'
      });
      
      const data = JSON.parse(result.content as string);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('get_landing Tool Execution', () => {
    it('should get landing page data', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          featured: [],
          trending: [],
          stats: {},
        }),
      });
      
      const result = await harness.executeTool('get_landing', {});
      
      const data = JSON.parse(result.content as string);
      expect(data.featured).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid tool name', async () => {
      const harness = await createHarness();
      
      await expect(
        harness.executeTool('non_existent_tool', {})
      ).rejects.toThrow();
    });

    it('should handle missing required params', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ quality: {}, compatible_skills: [] }),
      });
      
      const result = await harness.executeTool('get_skill', {});
      expect(result).toBeDefined();
    });

    it('should handle API errors', async () => {
      const harness = await createHarness();
      
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });
      
      await expect(
        harness.executeTool('get_stats', {})
      ).rejects.toThrow('Skills Hub API error: 500');
    });

    it('should handle network errors', async () => {
      const harness = await createHarness();
      
      mockFetch.mockRejectedValue(new Error('Network error'));
      
      await expect(
        harness.executeTool('get_stats', {})
      ).rejects.toThrow('Network error');
    });
  });
});
