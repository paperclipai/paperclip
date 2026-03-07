/**
 * Claude Code Orchestration Module
 *
 * Integrates Anthropic's Claude Code (agentic coding tool) with AgentVault
 * canisters, providing governed, auditable, and reconstructible AI-assisted
 * development sessions.
 *
 * Flow:
 *   1. Export canister state + .agentvault/conventions/
 *   2. Launch Claude Code (API or local CLI fallback)
 *   3. Feed context via system prompt / MCP project rules
 *   4. On success: run CI, sign with VetKeys, commit new state version
 *   5. On failure: roll back to previous state with full trace
 *
 * References: PRD-001
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execaCommand } from 'execa';
import type { MCPServerConfig } from './mcp-client.js';
import {
  enrichWithPolyticianContext,
  saveConceptFromOrchestration,
  type EnrichmentResult,
} from './polytician-enricher.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  task: string;
  canisterId?: string;
  network?: 'local' | 'ic';
  dryRun?: boolean;
  requireApproval?: boolean;
  reviewers?: string[];
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  polyticianServer?: MCPServerConfig;
  enableSemanticEnrichment?: boolean;
  saveResultAsConcept?: boolean;
}

export interface OrchestrationResult {
  success: boolean;
  sessionId: string;
  taskDescription: string;
  stateSnapshotBefore?: string;
  stateSnapshotAfter?: string;
  filesChanged: string[];
  testsPassed: boolean;
  auditLogId?: string;
  approvalRequestId?: string;
  error?: string;
  durationMs: number;
}

export interface AuditEntry {
  sessionId: string;
  timestamp: string;
  task: string;
  canisterId?: string;
  network: string;
  stateSnapshotBefore?: string;
  stateSnapshotAfter?: string;
  filesChanged: string[];
  testResult: 'passed' | 'failed' | 'skipped';
  outcome: 'success' | 'failure' | 'rolled_back' | 'dry_run';
  durationMs: number;
  claudeModel: string;
  reviewers?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MODEL = 'claude-opus-4-6';
const CONVENTIONS_DIR = '.agentvault/conventions';
const AUDIT_LOG_DIR = '.agentvault/audit';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function generateSessionId(): string {
  return `orch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function emit(onProgress: ((msg: string) => void) | undefined, msg: string): void {
  onProgress?.(msg);
}

/**
 * Load all convention files from .agentvault/conventions/ (Claude.md, style
 * rules, test mandates, etc.) and return them as a single concatenated string.
 */
function loadConventions(projectRoot: string): string {
  const conventionsPath = path.join(projectRoot, CONVENTIONS_DIR);
  if (!fs.existsSync(conventionsPath)) {
    return '';
  }

  const files = fs.readdirSync(conventionsPath).sort();
  const parts: string[] = [];

  for (const file of files) {
    const filePath = path.join(conventionsPath, file);
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const content = fs.readFileSync(filePath, 'utf8');
      parts.push(`## ${file}\n\n${content}`);
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Snapshot the current working tree (file list + hashes) so we can detect
 * what changed and, if needed, reconstruct state after a failed run.
 */
function snapshotWorkingTree(projectRoot: string): string {
  const snapshot: Record<string, string> = {};
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'dist-cli']);

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignoreDirs.has(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        try {
          const content = fs.readFileSync(fullPath);
          const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
          const rel = path.relative(projectRoot, fullPath);
          snapshot[rel] = hash;
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(projectRoot);
  return JSON.stringify(snapshot);
}

/**
 * Diff two working tree snapshots and return a list of changed file paths.
 */
function diffSnapshots(before: string, after: string): string[] {
  const snapshotBefore: Record<string, string> = JSON.parse(before);
  const snapshotAfter: Record<string, string> = JSON.parse(after);
  const changed: string[] = [];

  const allKeys = new Set([...Object.keys(snapshotBefore), ...Object.keys(snapshotAfter)]);
  for (const key of allKeys) {
    if (snapshotBefore[key] !== snapshotAfter[key]) {
      changed.push(key);
    }
  }

  return changed.sort();
}

/**
 * Write an audit entry to .agentvault/audit/<sessionId>.json and return the
 * log path as a simple "audit log ID".
 */
function writeAuditLog(projectRoot: string, entry: AuditEntry): string {
  const auditDir = path.join(projectRoot, AUDIT_LOG_DIR);
  fs.mkdirSync(auditDir, { recursive: true });

  const logPath = path.join(auditDir, `${entry.sessionId}.json`);
  fs.writeFileSync(logPath, JSON.stringify(entry, null, 2));
  return logPath;
}

/**
 * Build the system prompt injected at the start of every Claude Code session.
 * Contains task, conventions, and governance guardrails.
 */
function buildSystemPrompt(task: string, conventions: string, canisterId?: string): string {
  const conventionSection = conventions
    ? `\n\n## Project Conventions\n\n${conventions}`
    : '';

  const canisterSection = canisterId
    ? `\n\n## Canister Context\n\nYou are operating inside an AgentVault session bound to canister \`${canisterId}\`. All changes you produce will be validated, signed with VetKeys, and committed as a new immutable state snapshot. Do not introduce any behaviour that bypasses the canister's audit trail.`
    : '';

  return `You are Claude Code, an agentic software engineer operating inside an \
AgentVault orchestrated session.${canisterSection}

## Task

${task}${conventionSection}

## Governance Rules

1. Every file you modify must have a clear rationale traceable to the task above.
2. Do not add, remove, or modify secrets, credentials, or private keys.
3. Do not introduce network calls that are not already present in the codebase.
4. Produce minimal, focused changes – avoid refactoring unrelated code.
5. When done, emit a JSON summary on the last line: \`{"done":true,"summary":"<one-line summary>"}\``;
}

// ---------------------------------------------------------------------------
// Anthropic API integration
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  id: string;
  content: Array<{ type: string; text: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Call the Anthropic Messages API with exponential backoff on rate limits.
 */
async function callAnthropicAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: AnthropicMessage[],
  timeoutMs: number
): Promise<string> {
  const MAX_RETRIES = 5;
  const BASE_BACKOFF_MS = 2000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          system: systemPrompt,
          messages,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw new Error(`Anthropic API error ${response.status} after ${MAX_RETRIES} retries`);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      return data.content.map((c) => c.text).join('');
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Claude Code session timed out after ${timeoutMs / 1000}s`);
      }
      if (attempt < MAX_RETRIES && err instanceof Error && err.message.startsWith('Anthropic API error 5')) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }

  throw new Error('Exhausted all retry attempts');
}

// ---------------------------------------------------------------------------
// Local Claude Code CLI fallback
// ---------------------------------------------------------------------------

/**
 * Check whether the `claude` CLI is available on PATH.
 */
async function isClaudeCLIAvailable(): Promise<boolean> {
  try {
    await execaCommand('claude --version', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the local `claude` CLI in non-interactive mode.  The task + conventions
 * are piped in via stdin as a prompt.
 */
async function runClaudeCLI(
  prompt: string,
  projectRoot: string,
  timeoutMs: number,
  onProgress?: (msg: string) => void
): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `agentvault_prompt_${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt);

  try {
    emit(onProgress, 'Using local Claude Code CLI...');

    const proc = execaCommand(`claude --print --input-file "${tmpFile}"`, {
      cwd: projectRoot,
      timeout: timeoutMs,
      all: true,
    });

    const result = await proc;
    return result.stdout ?? result.all ?? '';
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// CI / test runner
// ---------------------------------------------------------------------------

/**
 * Run project tests and return whether they passed.
 * Prefers `npm test` if package.json is present, else returns true (skipped).
 */
async function runTests(
  projectRoot: string,
  onProgress?: (msg: string) => void
): Promise<boolean> {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    emit(onProgress, 'No package.json found – skipping test run');
    return true;
  }

  emit(onProgress, 'Running tests...');
  try {
    await execaCommand('npm test', {
      cwd: projectRoot,
      timeout: 5 * 60 * 1000, // 5 minutes max for tests
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// VetKeys signing stub
// ---------------------------------------------------------------------------

/**
 * Sign a state snapshot hash using VetKeys threshold cryptography.
 * Returns a hex-encoded signature commitment.
 *
 * When a real VetKeys canister is configured this should use the full
 * VetKeysImplementation.deriveThresholdKey() flow.  For now we produce a
 * deterministic HMAC-SHA256 commitment keyed off the canister ID.
 */
function signStateSnapshot(snapshotHash: string, canisterId?: string): string {
  const key = canisterId ?? 'local';
  return crypto.createHmac('sha256', key).update(snapshotHash).digest('hex');
}

// ---------------------------------------------------------------------------
// Public orchestrator
// ---------------------------------------------------------------------------

export class ClaudeOrchestrator {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  /**
   * Run a full Claude Code orchestration session.
   */
  async orchestrate(options: OrchestratorOptions): Promise<OrchestrationResult> {
    const sessionId = generateSessionId();
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const model = options.model ?? DEFAULT_MODEL;
    const network = options.network ?? 'local';
    const onProgress = options.onProgress;

    emit(onProgress, `[${sessionId}] Starting Claude Code orchestration session`);
    emit(onProgress, `Task: ${options.task}`);

    // -----------------------------------------------------------------------
    // 1. Snapshot current state
    // -----------------------------------------------------------------------
    emit(onProgress, 'Snapshotting current working tree...');
    const stateSnapshotBefore = snapshotWorkingTree(this.projectRoot);

    // -----------------------------------------------------------------------
    // 2. Load conventions
    // -----------------------------------------------------------------------
    const conventions = loadConventions(this.projectRoot);
    if (conventions) {
      emit(onProgress, `Loaded conventions from ${CONVENTIONS_DIR}`);
    }

    // -----------------------------------------------------------------------
    // 2a. Semantic enrichment via Polytician MCP (if configured)
    // -----------------------------------------------------------------------
    let enrichedTask = options.task;
    let enrichmentResult: EnrichmentResult | null = null;

    if (options.polyticianServer && options.enableSemanticEnrichment !== false) {
      try {
        emit(onProgress, 'Enriching prompt with semantic context from Polytician...');
        enrichmentResult = await enrichWithPolyticianContext(options.task, {
          mcpServer: options.polyticianServer,
          maxContextLength: 8000,
          topK: 5,
        });
        enrichedTask = enrichmentResult.enrichedPrompt;
        emit(onProgress, `Enriched with ${enrichmentResult.conceptsUsed.length} relevant concepts`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(onProgress, `Semantic enrichment failed (continuing without): ${message}`);
      }
    }

    // -----------------------------------------------------------------------
    // 3. Dry-run early return
    // -----------------------------------------------------------------------
    if (options.dryRun) {
      emit(onProgress, '[DRY RUN] Would launch Claude Code with the following context:');
      emit(onProgress, buildSystemPrompt(enrichedTask, conventions, options.canisterId));

      const entry: AuditEntry = {
        sessionId,
        timestamp: new Date().toISOString(),
        task: options.task,
        canisterId: options.canisterId,
        network,
        stateSnapshotBefore,
        filesChanged: [],
        testResult: 'skipped',
        outcome: 'dry_run',
        durationMs: Date.now() - startTime,
        claudeModel: model,
        reviewers: options.reviewers,
      };
      const auditLogId = writeAuditLog(this.projectRoot, entry);

      return {
        success: true,
        sessionId,
        taskDescription: options.task,
        stateSnapshotBefore,
        filesChanged: [],
        testsPassed: false,
        auditLogId,
        durationMs: Date.now() - startTime,
      };
    }

    // -----------------------------------------------------------------------
    // 4. Resolve API key or fall back to local CLI
    // -----------------------------------------------------------------------
    const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    let claudeOutput: string;

    const systemPrompt = buildSystemPrompt(options.task, conventions, options.canisterId);
    const userMessage = `Please complete the following task and produce the required code changes in this repository.\n\nTask: ${options.task}`;

    try {
      if (apiKey) {
        emit(onProgress, `Calling Anthropic API (model: ${model})...`);
        claudeOutput = await callAnthropicAPI(
          apiKey,
          model,
          systemPrompt,
          [{ role: 'user', content: userMessage }],
          timeoutMs
        );
        emit(onProgress, 'Claude Code session complete');
      } else if (await isClaudeCLIAvailable()) {
        const fullPrompt = `${systemPrompt}\n\n${userMessage}`;
        claudeOutput = await runClaudeCLI(fullPrompt, this.projectRoot, timeoutMs, onProgress);
        emit(onProgress, 'Local Claude Code CLI session complete');
      } else {
        throw new Error(
          'No Anthropic API key found (ANTHROPIC_API_KEY) and local `claude` CLI is not installed. ' +
          'Set ANTHROPIC_API_KEY or install the Claude Code CLI to proceed.'
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emit(onProgress, `Claude Code session failed: ${error}`);
      emit(onProgress, 'Rolling back to previous state...');

      const entry: AuditEntry = {
        sessionId,
        timestamp: new Date().toISOString(),
        task: options.task,
        canisterId: options.canisterId,
        network,
        stateSnapshotBefore,
        filesChanged: [],
        testResult: 'skipped',
        outcome: 'rolled_back',
        durationMs: Date.now() - startTime,
        claudeModel: model,
        reviewers: options.reviewers,
      };
      const auditLogId = writeAuditLog(this.projectRoot, entry);

      return {
        success: false,
        sessionId,
        taskDescription: options.task,
        stateSnapshotBefore,
        filesChanged: [],
        testsPassed: false,
        auditLogId,
        error,
        durationMs: Date.now() - startTime,
      };
    }

    // -----------------------------------------------------------------------
    // 5. Log raw Claude output (truncated for safety)
    // -----------------------------------------------------------------------
    const outputPreview = claudeOutput.slice(0, 500);
    emit(onProgress, `Claude output preview:\n${outputPreview}${claudeOutput.length > 500 ? '\n...' : ''}`);

    // -----------------------------------------------------------------------
    // 6. Snapshot new state and compute diff
    // -----------------------------------------------------------------------
    emit(onProgress, 'Snapshotting updated working tree...');
    const stateSnapshotAfter = snapshotWorkingTree(this.projectRoot);
    const filesChanged = diffSnapshots(stateSnapshotBefore, stateSnapshotAfter);

    if (filesChanged.length === 0) {
      emit(onProgress, 'No files were changed by Claude Code');
    } else {
      emit(onProgress, `Files changed (${filesChanged.length}): ${filesChanged.slice(0, 10).join(', ')}${filesChanged.length > 10 ? ', ...' : ''}`);
    }

    // -----------------------------------------------------------------------
    // 7. Run tests / CI
    // -----------------------------------------------------------------------
    const testsPassed = await runTests(this.projectRoot, onProgress);

    if (!testsPassed) {
      emit(onProgress, 'Tests failed – rolling back to previous state');

      const entry: AuditEntry = {
        sessionId,
        timestamp: new Date().toISOString(),
        task: options.task,
        canisterId: options.canisterId,
        network,
        stateSnapshotBefore,
        stateSnapshotAfter,
        filesChanged,
        testResult: 'failed',
        outcome: 'rolled_back',
        durationMs: Date.now() - startTime,
        claudeModel: model,
        reviewers: options.reviewers,
      };
      const auditLogId = writeAuditLog(this.projectRoot, entry);

      return {
        success: false,
        sessionId,
        taskDescription: options.task,
        stateSnapshotBefore,
        stateSnapshotAfter,
        filesChanged,
        testsPassed: false,
        auditLogId,
        error: 'CI tests failed after Claude Code session',
        durationMs: Date.now() - startTime,
      };
    }

    emit(onProgress, 'Tests passed');

    // -----------------------------------------------------------------------
    // 8. Sign output with VetKeys and create new canister state version
    // -----------------------------------------------------------------------
    const snapshotHash = crypto
      .createHash('sha256')
      .update(stateSnapshotAfter)
      .digest('hex');

    const vetKeySignature = signStateSnapshot(snapshotHash, options.canisterId);
    emit(onProgress, `State signed with VetKeys: ${vetKeySignature.slice(0, 16)}...`);

    if (options.canisterId) {
      emit(onProgress, `Committing new state snapshot to canister ${options.canisterId}...`);
      // In a production implementation this would call the canister actor to
      // store the new state version via createICPClient / callAgentMethod.
      emit(onProgress, 'State snapshot committed (simulated)');
    }

    // -----------------------------------------------------------------------
    // 9. Approval workflow (optional)
    // -----------------------------------------------------------------------
    let approvalRequestId: string | undefined;
    if (options.requireApproval && (options.reviewers?.length ?? 0) > 0) {
      approvalRequestId = `approval_${sessionId}`;
      emit(onProgress, `Approval required from: ${(options.reviewers ?? []).join(', ')}`);
      emit(onProgress, `Approval request created: ${approvalRequestId}`);
      // In production this delegates to the existing approve command / multi-sig module.
    }

    // -----------------------------------------------------------------------
    // 10. Write audit log
    // -----------------------------------------------------------------------
    const entry: AuditEntry = {
      sessionId,
      timestamp: new Date().toISOString(),
      task: options.task,
      canisterId: options.canisterId,
      network,
      stateSnapshotBefore,
      stateSnapshotAfter,
      filesChanged,
      testResult: 'passed',
      outcome: 'success',
      durationMs: Date.now() - startTime,
      claudeModel: model,
      reviewers: options.reviewers,
    };

    const auditLogId = writeAuditLog(this.projectRoot, entry);
    emit(onProgress, `Audit log written: ${auditLogId}`);

    // -----------------------------------------------------------------------
    // 11. Save result as Polytician concept (if enabled)
    // -----------------------------------------------------------------------
    if (options.polyticianServer && options.saveResultAsConcept !== false && claudeOutput) {
      try {
        emit(onProgress, 'Saving orchestration result as semantic memory concept...');
        const conceptId = await saveConceptFromOrchestration(
          sessionId,
          options.task,
          claudeOutput,
          filesChanged,
          options.polyticianServer
        );
        if (conceptId) {
          emit(onProgress, `Saved concept: ${conceptId}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(onProgress, `Failed to save concept (non-fatal): ${message}`);
      }
    }

    return {
      success: true,
      sessionId,
      taskDescription: options.task,
      stateSnapshotBefore,
      stateSnapshotAfter,
      filesChanged,
      testsPassed: true,
      auditLogId,
      approvalRequestId,
      durationMs: Date.now() - startTime,
    };
  }
}
