import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ReleaseGenerator } from '../../src/release-generator';
import { ArtifactParser } from '../../src/artifact-parser';
import { ChangelogWriter } from '../../src/changelog-writer';
import { GitHubIntegration } from '../../src/github-integration';
import { PaperclipAPI } from '../../src/paperclip-api';

/**
 * Integration tests for sprint-release-generator
 * Tests the complete flow from artifact parsing through release generation
 */

const FIXTURES_DIR = path.join(__dirname, '../fixtures/release-generator');
const TEST_SPRINT_ID = 'ABC123';
const TEMP_DIR = path.join(__dirname, '.test-output');

describe('sprint-release-generator Integration Tests', () => {
  let generator: ReleaseGenerator;
  let mockGitHub: any;
  let mockPaperclip: any;

  beforeEach(() => {
    // Create temporary directory
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Mock external API calls
    mockGitHub = {
      getPullRequest: vi.fn(),
      postComment: vi.fn(),
      getCommitRange: vi.fn(),
      updateLabels: vi.fn()
    };

    mockPaperclip = {
      getTask: vi.fn(),
      updateTask: vi.fn(),
      getTasks: vi.fn()
    };

    // Initialize generator with mocks
    generator = new ReleaseGenerator({
      sprintId: TEST_SPRINT_ID,
      github: mockGitHub,
      paperclip: mockPaperclip,
      dryRun: false
    });
  });

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  describe('Test 1: End-to-End with Phase 1 Artifacts', () => {
    it('should load and parse all Phase 1 test fixtures', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);

      const artifacts = await parser.parseAll();

      expect(artifacts).toBeDefined();
      expect(artifacts.sprintPlan).toBeDefined();
      expect(artifacts.taskBreakdown).toBeDefined();
      expect(artifacts.handoffs).toHaveLength(2);
      expect(artifacts.evaluations).toHaveLength(2);
      expect(artifacts.sprintReport).toBeDefined();
    });

    it('should extract all required fields from sprint-plan.md', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const plan = await parser.parseSprintPlan('valid-sprint-plan.md');

      expect(plan.sprintId).toBe('ABC123');
      expect(plan.date).toMatch(/2026-03-31/);
      expect(plan.duration).toBe(3);
      expect(plan.tasks).toContain('PAP-1234');
      expect(plan.tasks).toContain('PAP-1245');
      expect(plan.tasks).toContain('PAP-1256');
    });

    it('should extract all required fields from task-breakdown.md', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const breakdown = await parser.parseTaskBreakdown('valid-task-breakdown.md');

      expect(breakdown.tasks).toHaveLength(3);

      const task1234 = breakdown.tasks.find(t => t.papId === 'PAP-1234');
      expect(task1234).toBeDefined();
      expect(task1234?.effort).toBe(2.5);
      expect(task1234?.vLabel).toBe('V1');
      expect(task1234?.priority).toBe('P0');

      const task1256 = breakdown.tasks.find(t => t.papId === 'PAP-1256');
      expect(task1256?.vLabel).toBe('V2');
    });

    it('should extract all required fields from handoff files', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const handoffs = await parser.parseHandoffs([
        'valid-handoff-alpha.md',
        'valid-handoff-beta.md'
      ]);

      expect(handoffs).toHaveLength(2);

      const alphaHandoff = handoffs[0];
      expect(alphaHandoff.papId).toBe('PAP-1234');
      expect(alphaHandoff.engineer).toContain('Alice');
      expect(alphaHandoff.status).toBe('COMPLETE');
      expect(alphaHandoff.features.length).toBeGreaterThan(0);
    });

    it('should extract all required fields from eval reports', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const evals = await parser.parseEvaluations([
        'eval-pass.md',
        'eval-fail.md'
      ]);

      expect(evals).toHaveLength(2);

      const passEval = evals.find(e => e.papId === 'PAP-1234');
      expect(passEval).toBeDefined();
      expect(passEval?.scores.functionality).toBe(9);
      expect(passEval?.overallScore).toBe(34);
      expect(passEval?.status).toBe('PASS');

      const failEval = evals.find(e => e.papId === 'PAP-1256');
      expect(failEval?.status).toBe('FAIL');
      expect(failEval?.overallScore).toBe(22);
    });

    it('should generate valid markdown changelog entry', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const changelog = await generator.generateChangelogEntry();

      expect(changelog).toBeDefined();
      expect(changelog).toContain('# v2026.090.1');
      expect(changelog).toContain('Dashboard Redesign');
      expect(changelog).toContain('PAP-1234');
      expect(changelog).toContain('## Features Shipped');
      expect(changelog).toContain('## Features Dropped');
    });

    it('should include all shipped features in changelog', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const changelog = await generator.generateChangelogEntry();

      expect(changelog).toContain('PAP-1234');
      expect(changelog).toContain('PAP-1245');
      expect(changelog).not.toContain('34/40'); // Only shipped features in header
    });

    it('should include all evaluation data in QA summary table', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const changelog = await generator.generateChangelogEntry();

      expect(changelog).toContain('| Functionality | Product Depth | Visual Design | Code Quality |');
      expect(changelog).toContain('9/10');
      expect(changelog).toContain('8/10');
      expect(changelog).toContain('34/40 PASS');
    });
  });

  describe('Test 2: CHANGELOG.md Update', () => {
    it('should create CHANGELOG.md if missing', async () => {
      const changelogPath = path.join(TEMP_DIR, 'CHANGELOG.md');
      const writer = new ChangelogWriter(changelogPath);

      const entry = `# v2026.090.1\n\n> Released: 2026-03-31\n\n## Features Shipped\n\n- Feature 1\n`;
      await writer.append(entry);

      expect(fs.existsSync(changelogPath)).toBe(true);
      const content = fs.readFileSync(changelogPath, 'utf-8');
      expect(content).toContain('v2026.090.1');
    });

    it('should append new entry to existing CHANGELOG.md', async () => {
      const changelogPath = path.join(TEMP_DIR, 'CHANGELOG.md');

      // Create initial changelog with one entry
      const initialContent = `# v2026.090.1\n\n> Released: 2026-03-31\n\nInitial entry\n`;
      fs.writeFileSync(changelogPath, initialContent);

      const writer = new ChangelogWriter(changelogPath);
      const newEntry = `# v2026.090.2\n\n> Released: 2026-03-31\n\nSecond release same day\n`;
      await writer.append(newEntry);

      const content = fs.readFileSync(changelogPath, 'utf-8');
      expect(content).toContain('v2026.090.2');
      expect(content).toContain('v2026.090.1');
    });

    it('should maintain correct version ordering (newest first)', async () => {
      const changelogPath = path.join(TEMP_DIR, 'CHANGELOG.md');
      const writer = new ChangelogWriter(changelogPath);

      await writer.append('# v2026.090.1\n\nFirst\n');
      await writer.append('# v2026.090.2\n\nSecond\n');
      await writer.append('# v2026.091.1\n\nThird\n');

      const content = fs.readFileSync(changelogPath, 'utf-8');
      const v1Index = content.indexOf('v2026.091.1');
      const v2Index = content.indexOf('v2026.090.2');
      const v3Index = content.indexOf('v2026.090.1');

      expect(v1Index).toBeLessThan(v2Index);
      expect(v2Index).toBeLessThan(v3Index);
    });

    it('should preserve all data without loss', async () => {
      const changelogPath = path.join(TEMP_DIR, 'CHANGELOG.md');
      const writer = new ChangelogWriter(changelogPath);

      const entry1 = `# v2026.090.1\n\n- Feature A\n- Feature B\n`;
      const entry2 = `# v2026.090.2\n\n- Feature C\n- Feature D\n`;

      await writer.append(entry1);
      await writer.append(entry2);

      const content = fs.readFileSync(changelogPath, 'utf-8');
      expect(content).toContain('Feature A');
      expect(content).toContain('Feature B');
      expect(content).toContain('Feature C');
      expect(content).toContain('Feature D');
    });

    it('should handle concurrent writes safely', async () => {
      const changelogPath = path.join(TEMP_DIR, 'CHANGELOG.md');
      const writer = new ChangelogWriter(changelogPath);

      const promises = [
        writer.append('# v2026.090.1\n\nEntry 1\n'),
        writer.append('# v2026.090.2\n\nEntry 2\n'),
        writer.append('# v2026.090.3\n\nEntry 3\n')
      ];

      await Promise.all(promises);

      const content = fs.readFileSync(changelogPath, 'utf-8');
      const lineCount = content.split('\n').filter(l => l.startsWith('# v')).length;
      expect(lineCount).toBe(3);
    });
  });

  describe('Test 3: PR Comment Generation', () => {
    it('should generate PR comment from sprint artifacts', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const comment = await generator.generatePRComment();

      expect(comment).toContain('🚀 Release Report');
      expect(comment).toContain('v2026.090.1');
      expect(comment).toContain('### Feature Matrix');
      expect(comment).toContain('### Timeline');
    });

    it('should include all shipped features in feature matrix', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const comment = await generator.generatePRComment();

      expect(comment).toContain('PAP-1234');
      expect(comment).toContain('PAP-1245');
      expect(comment).toContain('✅ Shipped');
      expect(comment).toContain('34/40');
    });

    it('should include dropped features in feature matrix', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const comment = await generator.generatePRComment();

      expect(comment).toContain('PAP-1256');
      expect(comment).toContain('❌ Dropped');
      expect(comment).toContain('22/40 FAIL');
    });

    it('should render tables correctly', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const comment = await generator.generatePRComment();

      // Check for valid markdown table structure
      const tableMatches = comment.match(/\|.+\|.+\|/g);
      expect(tableMatches).not.toBeNull();
      expect(tableMatches!.length).toBeGreaterThan(2);
    });

    it('should not exceed 5000 character limit', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const comment = await generator.generatePRComment();

      expect(comment.length).toBeLessThan(5000);
    });

    it('should verify links are valid URLs', async () => {
      mockGitHub.getCommitRange.mockResolvedValue([
        { hash: 'abc123', prNumber: 2847, title: 'feat: dashboard redesign' },
        { hash: 'def456', prNumber: 2851, title: 'feat: real-time metrics' }
      ]);

      const comment = await generator.generatePRComment();

      // Check for valid PR links
      const prLinks = comment.match(/\[#\d+\]\(https:\/\/github\.com\/.+\/pull\/\d+\)/g);
      expect(prLinks).not.toBeNull();
      expect(prLinks!.length).toBeGreaterThan(0);
    });
  });

  describe('Test 4: Paperclip Issue Update (Mocked)', () => {
    it('should update Paperclip tasks for shipped features', async () => {
      mockPaperclip.updateTask.mockResolvedValue({
        status: 'released',
        releaseVersion: 'v2026.090.1'
      });

      await generator.updatePaperclipTasks();

      expect(mockPaperclip.updateTask).toHaveBeenCalled();
    });

    it('should only update shipped features, not dropped ones', async () => {
      mockPaperclip.updateTask.mockResolvedValue({ status: 'released' });

      await generator.updatePaperclipTasks();

      const calls = mockPaperclip.updateTask.mock.calls;
      const papIds = calls.map(c => c[0]);

      expect(papIds).toContain('PAP-1234');
      expect(papIds).toContain('PAP-1245');
      expect(papIds).not.toContain('PAP-1256');
    });

    it('should include release version in Paperclip update', async () => {
      mockPaperclip.updateTask.mockResolvedValue({ status: 'released' });

      await generator.updatePaperclipTasks();

      const calls = mockPaperclip.updateTask.mock.calls;
      calls.forEach(call => {
        expect(call[1]).toHaveProperty('releaseVersion');
        expect(call[1].releaseVersion).toMatch(/v\d{4}\.\d{3}\.\d+/);
      });
    });

    it('should retry on transient failures', async () => {
      let attempts = 0;
      mockPaperclip.updateTask.mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Network timeout');
        }
        return Promise.resolve({ status: 'released' });
      });

      await generator.updatePaperclipTasks();

      expect(attempts).toBeGreaterThanOrEqual(2);
    });

    it('should handle permanent failures gracefully', async () => {
      mockPaperclip.updateTask.mockRejectedValue(new Error('Invalid task ID'));

      const result = await generator.updatePaperclipTasks();

      // Should not throw, should log error and continue
      expect(result).toBeDefined();
    });

    it('should verify correct fields updated', async () => {
      mockPaperclip.updateTask.mockResolvedValue({
        status: 'released',
        releaseVersion: 'v2026.090.1',
        releasedAt: expect.stringMatching(/\d{4}-\d{2}-\d{2}/),
        updatedBy: 'release-generator'
      });

      await generator.updatePaperclipTasks();

      const calls = mockPaperclip.updateTask.mock.calls;
      calls.forEach(call => {
        const updateData = call[1];
        expect(updateData.status).toBe('released');
        expect(updateData.releaseVersion).toBeDefined();
        expect(updateData.releasedAt).toBeDefined();
      });
    });
  });

  describe('Test 5: GitHub Posting (Mocked)', () => {
    it('should post PR comment to GitHub', async () => {
      mockGitHub.postComment.mockResolvedValue({
        id: 123456,
        url: 'https://github.com/...'
      });

      await generator.postGitHubComment();

      expect(mockGitHub.postComment).toHaveBeenCalled();
    });

    it('should use correct PR number', async () => {
      mockGitHub.postComment.mockResolvedValue({ id: 123456 });

      await generator.postGitHubComment();

      const calls = mockGitHub.postComment.mock.calls;
      expect(calls[0][0]).toHaveProperty('prNumber');
    });

    it('should call with correct API format', async () => {
      mockGitHub.postComment.mockResolvedValue({ id: 123456 });

      await generator.postGitHubComment();

      const calls = mockGitHub.postComment.mock.calls;
      const request = calls[0][0];

      expect(request).toHaveProperty('body');
      expect(request.body).toMatch(/🚀 Release Report/);
    });

    it('should handle dry-run mode', async () => {
      const dryRunGenerator = new ReleaseGenerator({
        sprintId: TEST_SPRINT_ID,
        github: mockGitHub,
        paperclip: mockPaperclip,
        dryRun: true
      });

      await dryRunGenerator.postGitHubComment();

      expect(mockGitHub.postComment).not.toHaveBeenCalled();
    });

    it('should retry on transient failures', async () => {
      let attempts = 0;
      mockGitHub.postComment.mockImplementation(() => {
        attempts++;
        if (attempts < 2) {
          throw new Error('GitHub API timeout');
        }
        return Promise.resolve({ id: 123456 });
      });

      await generator.postGitHubComment();

      expect(attempts).toBeGreaterThanOrEqual(2);
    });

    it('should update PR labels after posting', async () => {
      mockGitHub.postComment.mockResolvedValue({ id: 123456 });
      mockGitHub.updateLabels.mockResolvedValue({});

      await generator.postGitHubComment();

      expect(mockGitHub.updateLabels).toHaveBeenCalled();
      const calls = mockGitHub.updateLabels.mock.calls;
      expect(calls[0][0]).toContain('released');
      expect(calls[0][0]).toContain('changelog-generated');
    });

    it('should handle PR not found error', async () => {
      mockGitHub.postComment.mockRejectedValue(new Error('PR #404 not found'));

      const result = await generator.postGitHubComment();

      // Should handle gracefully without throwing
      expect(result).toBeDefined();
    });

    it('should validate GitHub token is available', async () => {
      const invalidGenerator = new ReleaseGenerator({
        sprintId: TEST_SPRINT_ID,
        github: mockGitHub,
        paperclip: mockPaperclip,
        githubToken: undefined
      });

      const postResult = await invalidGenerator.postGitHubComment();

      expect(postResult).toHaveProperty('error');
      expect(postResult.error).toContain('token');
    });
  });

  describe('Test 6: CalVer Calculation', () => {
    it('should generate v2026.090.1 for first release on day 90', () => {
      const version = generator.calculateVersion(new Date('2026-03-31'));
      expect(version).toBe('v2026.090.1');
    });

    it('should generate v2026.091.1 for first release on day 91', () => {
      const version = generator.calculateVersion(new Date('2026-04-01'));
      expect(version).toBe('v2026.091.1');
    });

    it('should increment patch for multiple releases same day', async () => {
      const changelogPath = path.join(TEMP_DIR, 'CHANGELOG.md');
      const writer = new ChangelogWriter(changelogPath);

      await writer.append('# v2026.090.1\n\nFirst\n');
      await writer.append('# v2026.090.2\n\nSecond\n');

      const version = generator.calculateVersion(new Date('2026-03-31'), changelogPath);
      expect(version).toBe('v2026.090.3');
    });
  });

  describe('Test 7: Error Recovery', () => {
    it('should create backup of CHANGELOG before writing', async () => {
      const changelogPath = path.join(TEMP_DIR, 'CHANGELOG.md');
      const initialContent = '# v2026.090.1\n\nInitial\n';
      fs.writeFileSync(changelogPath, initialContent);

      const writer = new ChangelogWriter(changelogPath);
      await writer.append('# v2026.090.2\n\nNew\n');

      const backupPath = changelogPath + '.backup';
      expect(fs.existsSync(backupPath)).toBe(true);
      const backupContent = fs.readFileSync(backupPath, 'utf-8');
      expect(backupContent).toBe(initialContent);
    });

    it('should rollback CHANGELOG on write failure', async () => {
      const changelogPath = path.join(TEMP_DIR, 'CHANGELOG.md');
      const originalContent = '# v2026.090.1\n\nOriginal\n';
      fs.writeFileSync(changelogPath, originalContent);
      fs.writeFileSync(changelogPath + '.backup', originalContent);

      const writer = new ChangelogWriter(changelogPath);
      // Simulate write failure by making directory read-only
      fs.chmodSync(changelogPath, 0o444);

      try {
        await writer.append('# v2026.090.2\n\nShould fail\n');
        fs.chmodSync(changelogPath, 0o644);
      } catch (error) {
        fs.chmodSync(changelogPath, 0o644);
        // Should have rolled back
        const content = fs.readFileSync(changelogPath, 'utf-8');
        expect(content).toBe(originalContent);
      }
    });
  });

  describe('Test 8: Validation', () => {
    it('should validate all Paperclip IDs are properly formatted', async () => {
      const comment = await generator.generatePRComment();
      const papIds = comment.match(/PAP-\d{4}/g) || [];

      papIds.forEach(id => {
        expect(id).toMatch(/^PAP-\d{4}$/);
      });
    });

    it('should validate QA scores are valid (0-40)', async () => {
      const comment = await generator.generatePRComment();
      const scores = comment.match(/(\d+)\/40/g) || [];

      scores.forEach(score => {
        const num = parseInt(score.split('/')[0]);
        expect(num).toBeGreaterThanOrEqual(0);
        expect(num).toBeLessThanOrEqual(40);
      });
    });

    it('should validate markdown syntax in generated content', async () => {
      const changelog = await generator.generateChangelogEntry();

      // Check for balanced markdown elements
      const headerCount = (changelog.match(/^#+ /gm) || []).length;
      const listCount = (changelog.match(/^- /gm) || []).length;

      expect(headerCount).toBeGreaterThan(0);
      expect(changelog).toMatch(/\|.*\|.*\|/); // At least one table
    });
  });
});

describe('Release Generator - Additional Edge Cases', () => {
  it('should handle corrupted evaluation file gracefully', async () => {
    const parser = new ArtifactParser(FIXTURES_DIR);
    const result = await parser.parseEvaluations(['corrupted-eval.md']);

    expect(result).toBeDefined();
    // Should not throw, should return empty or partial results
  });

  it('should generate release report with missing handoff files', async () => {
    const generator = new ReleaseGenerator({
      sprintId: TEST_SPRINT_ID,
      github: {} as any,
      paperclip: {} as any
    });

    const result = await generator.generateChangelogEntry();

    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it('should include contributor attribution correctly', async () => {
    const mockGitHub = {
      getCommitRange: vi.fn().mockResolvedValue([
        {
          hash: 'abc123',
          prNumber: 2847,
          title: 'feat: dashboard redesign',
          author: 'alice'
        }
      ]),
      postComment: vi.fn(),
      updateLabels: vi.fn()
    };

    const generator = new ReleaseGenerator({
      sprintId: TEST_SPRINT_ID,
      github: mockGitHub,
      paperclip: {} as any
    });

    const comment = await generator.generatePRComment();

    expect(comment).toContain('@alice');
  });
});
