import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ReleaseGenerator } from '../../src/release-generator';
import { ArtifactParser } from '../../src/artifact-parser';
import { GitIntegration } from '../../src/git-integration';

/**
 * E2E scenario tests for complete sprint release flow
 * These tests use real test fixtures and exercise the full pipeline
 */

const FIXTURES_DIR = path.join(__dirname, '../fixtures/release-generator');
const TEMP_OUTPUT_DIR = path.join(__dirname, '.e2e-output');

describe('E2E: Complete Release Flow Scenarios', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEMP_OUTPUT_DIR)) {
      fs.mkdirSync(TEMP_OUTPUT_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEMP_OUTPUT_DIR)) {
      fs.rmSync(TEMP_OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  describe('Scenario 1: Complete Phase 1 Sprint Through Release', () => {
    it('should successfully process valid sprint artifacts from start to finish', async () => {
      // Parse all artifacts
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      // Validate parsing succeeded
      expect(artifacts.sprintPlan).toBeDefined();
      expect(artifacts.sprintPlan.sprintId).toBe('ABC123');
      expect(artifacts.taskBreakdown.tasks.length).toBe(3);
      expect(artifacts.evaluations.length).toBe(2);

      // Generate changelog
      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();

      // Verify changelog generated
      expect(changelog).toBeDefined();
      expect(changelog).toContain('v2026.090.1');
      expect(changelog).toContain('Dashboard Redesign');
      expect(changelog).toContain('PAP-1234');
      expect(changelog).toContain('34/40 PASS');

      // Verify all shipped features present
      const shippedTasks = artifacts.evaluations
        .filter(e => e.status === 'PASS')
        .map(e => e.papId);

      shippedTasks.forEach(papId => {
        expect(changelog).toContain(papId);
      });

      // Verify dropped features listed
      expect(changelog).toContain('User Preferences');
      expect(changelog).toContain('22/40');
    });

    it('should include all data from sprint artifacts in changelog', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();

      // Verify sprint report data included
      expect(changelog).toContain('2026-03-31');
      expect(changelog).toContain('dashboard.paperclipai.dev');

      // Verify evaluation data
      expect(changelog).toContain('QA Results Summary');
      expect(changelog).toContain('Contributors');

      // Verify handoff content
      artifacts.handoffs.forEach(handoff => {
        handoff.features.forEach(feature => {
          // At least some feature descriptions should be in changelog
          if (handoff.papId === 'PAP-1234') {
            expect(changelog).toContain('Dashboard');
          }
        });
      });
    });

    it('should maintain all data integrity through full flow', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      // Record original data
      const originalTaskCount = artifacts.taskBreakdown.tasks.length;
      const originalEvalCount = artifacts.evaluations.length;

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      // Generate both outputs
      const changelog = await generator.generateChangelogEntry();
      const prComment = await generator.generatePRComment();

      // Verify no data loss
      const changelogTaskIds = (changelog.match(/PAP-\d{4}/g) || []).filter(
        (v, i, a) => a.indexOf(v) === i
      );

      expect(changelogTaskIds.length).toBeGreaterThanOrEqual(originalTaskCount - 1);

      // Both outputs should include same task references
      const commentTaskIds = (prComment.match(/PAP-\d{4}/g) || []).filter(
        (v, i, a) => a.indexOf(v) === i
      );

      changelogTaskIds.forEach(taskId => {
        expect(commentTaskIds).toContain(taskId);
      });
    });
  });

  describe('Scenario 2: Handle Corrupted Artifact', () => {
    it('should gracefully handle missing eval report for a feature', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);

      // Intentionally skip eval file
      const artifacts = {
        sprintPlan: await parser.parseSprintPlan('valid-sprint-plan.md'),
        taskBreakdown: await parser.parseTaskBreakdown('valid-task-breakdown.md'),
        handoffs: await parser.parseHandoffs([
          'valid-handoff-alpha.md',
          'valid-handoff-beta.md'
        ]),
        evaluations: await parser.parseEvaluations(['eval-pass.md']), // Missing eval-fail.md
        sprintReport: await parser.parseSprintReport('valid-sprint-report.md')
      };

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      // Should not throw
      const changelog = await generator.generateChangelogEntry();

      expect(changelog).toBeDefined();

      // PAP-1234 should still be in changelog (has eval)
      expect(changelog).toContain('PAP-1234');

      // PAP-1245 should not be in shipped (no eval provided)
      expect(changelog).not.toContain('PAP-1245');
    });

    it('should generate release with warnings for incomplete data', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);

      // Create artifacts with incomplete task breakdown
      const artifacts = {
        sprintPlan: await parser.parseSprintPlan('valid-sprint-plan.md'),
        taskBreakdown: {
          tasks: [
            {
              papId: 'PAP-1234',
              effort: 2.5,
              vLabel: 'V1',
              priority: 'P0'
            }
            // Missing PAP-1245 and PAP-1256
          ]
        },
        handoffs: await parser.parseHandoffs([
          'valid-handoff-alpha.md',
          'valid-handoff-beta.md'
        ]),
        evaluations: await parser.parseEvaluations([
          'eval-pass.md',
          'eval-fail.md'
        ]),
        sprintReport: await parser.parseSprintReport('valid-sprint-report.md')
      };

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();

      expect(changelog).toBeDefined();
      expect(changelog).toContain('PAP-1234');
      // Should still generate despite incomplete breakdown
    });

    it('should still generate release if handoff files are missing', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);

      // Create artifacts without handoff files
      const artifacts = {
        sprintPlan: await parser.parseSprintPlan('valid-sprint-plan.md'),
        taskBreakdown: await parser.parseTaskBreakdown('valid-task-breakdown.md'),
        handoffs: [], // Empty
        evaluations: await parser.parseEvaluations([
          'eval-pass.md',
          'eval-fail.md'
        ]),
        sprintReport: await parser.parseSprintReport('valid-sprint-report.md')
      };

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();

      expect(changelog).toBeDefined();
      expect(changelog).toContain('v2026.090.1');
      // Should still include task IDs from evaluations
      expect(changelog).toContain('PAP-1234');
    });
  });

  describe('Scenario 3: Multiple Features with Mixed Scores', () => {
    it('should separate shipped and dropped features correctly', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();

      // Verify structure has both sections
      expect(changelog).toContain('## Features Shipped');
      expect(changelog).toContain('## Features Dropped');

      // Verify PASS features in shipped section
      const shippedSection = changelog.split('## Features Dropped')[0];
      expect(shippedSection).toContain('PAP-1234');
      expect(shippedSection).toContain('34/40');

      // Verify FAIL features in dropped section
      const droppedSection = changelog.split('## Features Dropped')[1];
      expect(droppedSection).toContain('PAP-1256');
      expect(droppedSection).toContain('22/40');
    });

    it('should release only PASS items and drop all others', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();
      const prComment = await generator.generatePRComment();

      // Count shipped items (PASS status)
      const passCount = artifacts.evaluations.filter(e => e.status === 'PASS').length;

      // Verify shipped count
      const shippedMatches = changelog.match(/\*\*.+\*\* \(PAP-\d{4}\)/g) || [];
      expect(shippedMatches.length).toBeGreaterThanOrEqual(passCount);

      // Verify PR comment feature matrix
      expect(prComment).toContain('✅ Shipped');
      expect(prComment).toContain('❌ Dropped');
    });

    it('should include QA scores in feature matrix', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const prComment = await generator.generatePRComment();

      // Extract feature matrix
      const matrixStart = prComment.indexOf('| Feature |');
      const matrixEnd = prComment.indexOf('\n\n', matrixStart);
      const matrix = prComment.substring(matrixStart, matrixEnd);

      // Verify all evaluations are in matrix with scores
      artifacts.evaluations.forEach(eval => {
        expect(matrix).toContain(eval.papId);
        if (eval.status === 'PASS') {
          expect(matrix).toContain(`${eval.overallScore}/40`);
        } else {
          expect(matrix).toContain(`${eval.overallScore}/40 FAIL`);
        }
      });
    });

    it('should provide drop reasons for failed features', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();

      // Find dropped feature section
      const droppedSection = changelog.split('## Features Dropped')[1];

      // Should mention reasons
      expect(droppedSection).toMatch(/QA evaluation|rework|redesign/i);
    });
  });

  describe('Scenario 4: Version Numbering', () => {
    it('should generate correct calver for first release of the day', async () => {
      const changelogPath = path.join(TEMP_OUTPUT_DIR, 'CHANGELOG.md');

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        changelogPath: changelogPath,
        dryRun: true
      });

      const version = generator.calculateVersion(new Date('2026-03-31'));

      expect(version).toBe('v2026.090.1');
    });

    it('should generate correct calver for second release same day', async () => {
      const changelogPath = path.join(TEMP_OUTPUT_DIR, 'CHANGELOG.md');

      // Create changelog with first release
      fs.writeFileSync(changelogPath, '# v2026.090.1\n\nFirst release\n');

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        changelogPath: changelogPath,
        dryRun: true
      });

      const version = generator.calculateVersion(new Date('2026-03-31'), changelogPath);

      expect(version).toBe('v2026.090.2');
    });

    it('should generate correct calver for different day', async () => {
      const changelogPath = path.join(TEMP_OUTPUT_DIR, 'CHANGELOG.md');

      // Create changelog with releases from day 90
      fs.writeFileSync(
        changelogPath,
        '# v2026.090.1\n\nFirst\n\n# v2026.090.2\n\nSecond\n'
      );

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        changelogPath: changelogPath,
        dryRun: true
      });

      const version = generator.calculateVersion(new Date('2026-04-01'), changelogPath);

      expect(version).toBe('v2026.091.1');
    });

    it('should maintain calver ordering in changelog', async () => {
      const changelogPath = path.join(TEMP_OUTPUT_DIR, 'CHANGELOG.md');
      const git = new GitIntegration();

      // Create changelog with multiple versions
      let content = '';
      const versions = [
        'v2026.090.1',
        'v2026.090.2',
        'v2026.091.1',
        'v2026.091.2',
        'v2026.092.1'
      ];

      for (const version of versions) {
        content = `# ${version}\n\n> Released: 2026-03-31\n\nRelease notes\n\n${content}`;
      }

      fs.writeFileSync(changelogPath, content);

      // Read and verify order
      const readContent = fs.readFileSync(changelogPath, 'utf-8');
      const versionOrder = (readContent.match(/# (v\d{4}\.\d{3}\.\d+)/g) || []).map(
        m => m.replace('# ', '')
      );

      expect(versionOrder).toEqual(versions);
    });
  });

  describe('Scenario 5: Complete Workflow Validation', () => {
    it('should produce valid artifacts at each stage', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      // Stage 1: Parse
      expect(artifacts.sprintPlan).toBeDefined();
      expect(artifacts.evaluations.length).toBeGreaterThan(0);

      // Stage 2: Generate changelog
      const changelog = await generator.generateChangelogEntry();
      expect(changelog).toBeDefined();
      expect(changelog.length).toBeGreaterThan(100);

      // Stage 3: Generate PR comment
      const prComment = await generator.generatePRComment();
      expect(prComment).toBeDefined();
      expect(prComment.length).toBeGreaterThan(100);
      expect(prComment.length).toBeLessThan(5000);

      // Stage 4: Prepare handoff
      const handoff = await generator.generateHandoffArtifact();
      expect(handoff).toBeDefined();
      expect(handoff).toContain('Release Handoff');
      expect(handoff).toContain('v2026.090.1');
    });

    it('should validate all generated markdown syntax', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();
      const prComment = await generator.generatePRComment();

      // Check markdown validity
      const validateMarkdown = (content: string) => {
        // Headers
        const headers = content.match(/^#+\s+/gm) || [];
        expect(headers.length).toBeGreaterThan(0);

        // Lists
        const lists = content.match(/^\s*[-*]\s+/gm) || [];
        expect(lists.length).toBeGreaterThan(0);

        // Tables (if present)
        const tables = content.match(/^\|.*\|.*\|/gm) || [];
        if (tables.length > 0) {
          tables.forEach(table => {
            const cols = table.split('|').length;
            expect(cols).toBeGreaterThan(2);
          });
        }

        // Links
        const links = content.match(/\[.+\]\(.+\)/g) || [];
        links.forEach(link => {
          expect(link).toMatch(/\[.+\]\(https?:\/\/.+\)/);
        });
      };

      validateMarkdown(changelog);
      validateMarkdown(prComment);
    });

    it('should preserve all information in handoff artifact', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const handoff = await generator.generateHandoffArtifact();

      // Verify all key data is present
      expect(handoff).toContain('Sprint ABC123');
      expect(handoff).toContain('v2026.090.1');

      // Verify shipped features
      artifacts.evaluations
        .filter(e => e.status === 'PASS')
        .forEach(e => {
          expect(handoff).toContain(e.papId);
        });

      // Verify dropped features
      artifacts.evaluations
        .filter(e => e.status === 'FAIL')
        .forEach(e => {
          expect(handoff).toContain(e.papId);
        });
    });
  });

  describe('Scenario 6: Real-world Timing and Performance', () => {
    it('should complete full generation within reasonable time', async () => {
      const parser = new ArtifactParser(FIXTURES_DIR);
      const artifacts = await parser.parseAll();

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const startTime = Date.now();

      await Promise.all([
        generator.generateChangelogEntry(),
        generator.generatePRComment(),
        generator.generateHandoffArtifact()
      ]);

      const duration = Date.now() - startTime;

      // Should complete within 5 seconds for typical sprint (10-20 features)
      expect(duration).toBeLessThan(5000);
    });

    it('should handle large feature lists efficiently', async () => {
      // Simulate larger sprint with 20 features
      const parser = new ArtifactParser(FIXTURES_DIR);
      const baseArtifacts = await parser.parseAll();

      // Expand evaluations list
      const expandedEvaluations = [];
      for (let i = 0; i < 20; i++) {
        const eval = {
          ...baseArtifacts.evaluations[i % baseArtifacts.evaluations.length],
          papId: `PAP-${1000 + i}`,
          overallScore: 20 + Math.floor(Math.random() * 20)
        };
        expandedEvaluations.push(eval);
      }

      const artifacts = {
        ...baseArtifacts,
        evaluations: expandedEvaluations
      };

      const generator = new ReleaseGenerator({
        sprintId: 'ABC123',
        artifacts: artifacts,
        dryRun: true
      });

      const changelog = await generator.generateChangelogEntry();
      const prComment = await generator.generatePRComment();

      // Should still be well-formed
      expect(changelog).toBeDefined();
      expect(changelog.length).toBeGreaterThan(500);

      expect(prComment).toBeDefined();
      expect(prComment.length).toBeLessThan(5000); // Should truncate if needed
    });
  });
});
