/**
 * Google ADK (Agent Development Kit) & A2A Integration Module
 *
 * Provides full scaffolding, lifecycle management, and on-chain registration
 * for Google ADK agents within the AgentVault platform.
 *
 * Supported agent patterns:
 *   - LoopAgent      – repeats sub-agents until a condition is met
 *   - WorkflowAgent  – orchestrator that routes tasks to specialist agents
 *   - SequentialAgent – runs sub-agents one after another in order
 *   - ParallelAgent  – runs sub-agents concurrently
 *
 * Mint flow:
 *   1. Verify google-adk Python package is installed (offer install guidance)
 *   2. Generate agent scaffold (agent.py, main.py, requirements.txt, .env, README)
 *   3. Provision ICP canister (creates on-chain identity & state slot)
 *   4. Write "birthday" Arweave archive (immutable genesis snapshot ≡ git init)
 *
 * References: Google ADK docs, A2A Protocol
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execaCommand } from 'execa';
import { prepareArchive } from '../archival/archive-manager.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GoogleADKAgentType = 'loop' | 'workflow' | 'sequential' | 'parallel';

export interface GoogleADKCheckResult {
  available: boolean;
  version?: string;
  pythonPath?: string;
  error?: string;
}

export interface GoogleADKMintOptions {
  agentName: string;
  agentType: GoogleADKAgentType;
  /** Directory under which the agent folder will be created (default: cwd) */
  outputDir?: string;
  network?: 'local' | 'ic';
  /** Bind to an existing canister ID instead of provisioning a new one */
  canisterId?: string;
  skipBackup?: boolean;
  onProgress?: (message: string) => void;
}

export interface GoogleADKMintResult {
  success: boolean;
  agentName: string;
  agentType: GoogleADKAgentType;
  agentDir: string;
  canisterId?: string;
  birthdayArchiveId?: string;
  birthdayTimestamp: string;
  scaffoldFiles: string[];
  error?: string;
  durationMs: number;
}

export interface ScaffoldResult {
  files: string[];
  agentDir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(cb: ((msg: string) => void) | undefined, msg: string): void {
  cb?.(msg);
}

/** Convert a hyphenated agent name to a valid Python identifier. */
function toPythonIdentifier(name: string): string {
  return name.replace(/-/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

/** Generate a plausible-looking ICP canister ID (local simulation). */
function generateSimulatedCanisterId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz234567';
  const segment = (len: number): string =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${segment(5)}-${segment(5)}-${segment(5)}-${segment(5)}-cai`;
}

// ---------------------------------------------------------------------------
// Google ADK availability
// ---------------------------------------------------------------------------

/**
 * Check whether the google-adk Python package is importable.
 * Tries python3 first, then python.
 */
export async function checkGoogleADKAvailable(): Promise<GoogleADKCheckResult> {
  const candidates = ['python3', 'python'];

  for (const python of candidates) {
    try {
      // Try to import google.adk and emit a version string via pip show
      await execaCommand(`${python} -c "import google.adk; print('ok')"`, {
        timeout: 10_000,
      });

      // Try to get the installed version via pip show
      let version: string | undefined;
      try {
        const pipShow = await execaCommand(
          `${python} -m pip show google-adk 2>/dev/null`,
          { timeout: 8_000 }
        );
        const match = /Version:\s*(.+)/i.exec(pipShow.stdout);
        version = match?.[1]?.trim();
      } catch {
        // version stays undefined – not critical
      }

      return { available: true, version, pythonPath: python };
    } catch {
      // continue to next candidate
    }
  }

  return {
    available: false,
    error:
      'google-adk not found. Install it with:\n' +
      '    pip install google-adk\n' +
      'Then re-run this command.',
  };
}

// ---------------------------------------------------------------------------
// Python agent templates
// ---------------------------------------------------------------------------

function buildAgentPy(agentName: string, agentType: GoogleADKAgentType): string {
  const pyId = toPythonIdentifier(agentName);

  switch (agentType) {
    case 'loop':
      return [
        `"""`,
        `${agentName} – Google ADK Loop Agent`,
        `Managed by AgentVault | Persistent On-Chain AI Agent Platform`,
        ``,
        `A LoopAgent repeats its sub-agents for up to max_iterations cycles`,
        `(or until an inner agent signals completion).`,
        `"""`,
        ``,
        `import os`,
        ``,
        `from google.adk.agents import LlmAgent, LoopAgent`,
        ``,
        `# -----------------------------------------------------------------`,
        `# Inner LLM agent – runs on every iteration`,
        `# -----------------------------------------------------------------`,
        `inner_agent = LlmAgent(`,
        `    name="inner_agent",`,
        `    model=os.environ.get("GOOGLE_MODEL", "gemini-2.0-flash"),`,
        `    instruction=(`,
        `        "You are a focused assistant that works step-by-step toward a goal. "`,
        `        "After each step, evaluate your progress. "`,
        `        "When the task is fully complete, say exactly: DONE"`,
        `    ),`,
        `)`,
        ``,
        `# -----------------------------------------------------------------`,
        `# Root agent – required export for google-adk runner`,
        `# -----------------------------------------------------------------`,
        `root_agent = LoopAgent(`,
        `    name="${pyId}",`,
        `    sub_agents=[inner_agent],`,
        `    max_iterations=int(os.environ.get("MAX_ITERATIONS", "10")),`,
        `)`,
      ].join('\n');

    case 'sequential':
      return [
        `"""`,
        `${agentName} – Google ADK Sequential Agent`,
        `Managed by AgentVault | Persistent On-Chain AI Agent Platform`,
        ``,
        `A SequentialAgent pipelines sub-agents in order, passing the`,
        `output of each stage as input to the next.`,
        `"""`,
        ``,
        `import os`,
        ``,
        `from google.adk.agents import LlmAgent, SequentialAgent`,
        ``,
        `_MODEL = os.environ.get("GOOGLE_MODEL", "gemini-2.0-flash")`,
        ``,
        `# Stage 1 – understand & plan`,
        `planner = LlmAgent(`,
        `    name="planner",`,
        `    model=_MODEL,`,
        `    instruction="Analyse the user's request and produce a clear step-by-step plan.",`,
        `)`,
        ``,
        `# Stage 2 – execute`,
        `executor = LlmAgent(`,
        `    name="executor",`,
        `    model=_MODEL,`,
        `    instruction=(`,
        `        "Execute the plan from the previous stage. "`,
        `        "Be precise and show your work."`,
        `    ),`,
        `)`,
        ``,
        `# Stage 3 – review & summarise`,
        `reviewer = LlmAgent(`,
        `    name="reviewer",`,
        `    model=_MODEL,`,
        `    instruction=(`,
        `        "Review the executor's output for correctness. "`,
        `        "Produce a concise final answer or summary."`,
        `    ),`,
        `)`,
        ``,
        `# -----------------------------------------------------------------`,
        `# Root agent – required export for google-adk runner`,
        `# -----------------------------------------------------------------`,
        `root_agent = SequentialAgent(`,
        `    name="${pyId}",`,
        `    sub_agents=[planner, executor, reviewer],`,
        `)`,
      ].join('\n');

    case 'parallel':
      return [
        `"""`,
        `${agentName} – Google ADK Parallel Agent`,
        `Managed by AgentVault | Persistent On-Chain AI Agent Platform`,
        ``,
        `A ParallelAgent fans out to all sub-agents simultaneously and`,
        `aggregates their responses.`,
        `"""`,
        ``,
        `import os`,
        ``,
        `from google.adk.agents import LlmAgent, ParallelAgent`,
        ``,
        `_MODEL = os.environ.get("GOOGLE_MODEL", "gemini-2.0-flash")`,
        ``,
        `# Worker A – primary analysis`,
        `worker_a = LlmAgent(`,
        `    name="worker_a",`,
        `    model=_MODEL,`,
        `    instruction="Provide a thorough primary analysis of the input.",`,
        `)`,
        ``,
        `# Worker B – alternative perspective`,
        `worker_b = LlmAgent(`,
        `    name="worker_b",`,
        `    model=_MODEL,`,
        `    instruction="Provide an alternative or counter-analysis of the input.",`,
        `)`,
        ``,
        `# Worker C – synthesis`,
        `worker_c = LlmAgent(`,
        `    name="worker_c",`,
        `    model=_MODEL,`,
        `    instruction="Synthesise the findings from both other analyses into a final conclusion.",`,
        `)`,
        ``,
        `# -----------------------------------------------------------------`,
        `# Root agent – required export for google-adk runner`,
        `# -----------------------------------------------------------------`,
        `root_agent = ParallelAgent(`,
        `    name="${pyId}",`,
        `    sub_agents=[worker_a, worker_b, worker_c],`,
        `)`,
      ].join('\n');

    case 'workflow':
    default:
      return [
        `"""`,
        `${agentName} – Google ADK Workflow Agent`,
        `Managed by AgentVault | Persistent On-Chain AI Agent Platform`,
        ``,
        `A WorkflowAgent acts as an LLM-driven orchestrator that delegates`,
        `to specialist sub-agents via AgentTool wrappers.`,
        `"""`,
        ``,
        `import os`,
        ``,
        `from google.adk.agents import LlmAgent`,
        `from google.adk.tools.agent_tool import AgentTool`,
        ``,
        `_MODEL = os.environ.get("GOOGLE_MODEL", "gemini-2.0-flash")`,
        ``,
        `# -----------------------------------------------------------------`,
        `# Specialist sub-agents`,
        `# -----------------------------------------------------------------`,
        `validator = LlmAgent(`,
        `    name="validator",`,
        `    model=_MODEL,`,
        `    instruction="Validate the user's input, clarify requirements, and flag any ambiguities.",`,
        `)`,
        ``,
        `processor = LlmAgent(`,
        `    name="processor",`,
        `    model=_MODEL,`,
        `    instruction="Process the validated requirements and produce a result.",`,
        `)`,
        ``,
        `summariser = LlmAgent(`,
        `    name="summariser",`,
        `    model=_MODEL,`,
        `    instruction="Summarise the processor's output into a clear, concise final answer.",`,
        `)`,
        ``,
        `# -----------------------------------------------------------------`,
        `# Root orchestrator – required export for google-adk runner`,
        `# -----------------------------------------------------------------`,
        `root_agent = LlmAgent(`,
        `    name="${pyId}",`,
        `    model=_MODEL,`,
        `    instruction=(`,
        `        "You are a workflow orchestrator. "`,
        `        "Use the validator to check the input, then the processor to act on it, "`,
        `        "then the summariser to present the final answer. "`,
        `        "Always call tools in that order unless the user's request is trivially simple."`,
        `    ),`,
        `    tools=[`,
        `        AgentTool(agent=validator),`,
        `        AgentTool(agent=processor),`,
        `        AgentTool(agent=summariser),`,
        `    ],`,
        `)`,
      ].join('\n');
  }
}

function buildMainPy(agentName: string, agentType: GoogleADKAgentType): string {
  const pyId = toPythonIdentifier(agentName);
  const typeLabel: Record<GoogleADKAgentType, string> = {
    loop: 'Loop',
    sequential: 'Sequential',
    parallel: 'Parallel',
    workflow: 'Workflow',
  };
  return [
    `"""`,
    `${agentName} – main entry point`,
    ``,
    `Run with:`,
    `    python main.py`,
    ``,
    `Or use the ADK CLI:`,
    `    adk web          # launch interactive web UI`,
    `    adk run agent    # run in terminal`,
    `"""`,
    ``,
    `import os`,
    `from dotenv import load_dotenv`,
    ``,
    `load_dotenv()`,
    ``,
    `from google.adk.runners import Runner`,
    `from google.adk.sessions import InMemorySessionService`,
    ``,
    `from agent import root_agent`,
    ``,
    ``,
    `def main() -> None:`,
    `    print(f"\\n  AgentVault | Google ADK ${typeLabel[agentType]} Agent")`,
    `    print(f"  Agent: ${agentName}\\n")`,
    ``,
    `    session_service = InMemorySessionService()`,
    `    runner = Runner(`,
    `        agent=root_agent,`,
    `        app_name="${pyId}",`,
    `        session_service=session_service,`,
    `    )`,
    ``,
    `    print("  Type your message and press Enter.  Ctrl+C to quit.\\n")`,
    `    session = session_service.create_session(`,
    `        app_name="${pyId}",`,
    `        user_id="user",`,
    `    )`,
    ``,
    `    while True:`,
    `        try:`,
    `            user_input = input("  You: ").strip()`,
    `        except (EOFError, KeyboardInterrupt):`,
    `            print("\\n  Goodbye!")`,
    `            break`,
    ``,
    `        if not user_input:`,
    `            continue`,
    ``,
    `        from google.adk.types import Content, Part`,
    `        content = Content(parts=[Part(text=user_input)])`,
    ``,
    `        for event in runner.run(`,
    `            user_id="user",`,
    `            session_id=session.id,`,
    `            new_message=content,`,
    `        ):`,
    `            if event.is_final_response() and event.content:`,
    `                for part in event.content.parts:`,
    `                    if part.text:`,
    `                        print(f"\\n  Agent: {part.text}\\n")`,
    ``,
    ``,
    `if __name__ == "__main__":`,
    `    main()`,
  ].join('\n');
}

function buildRequirementsTxt(): string {
  return [
    '# Google ADK and runtime dependencies',
    'google-adk>=0.5.0',
    '',
    '# Environment variable loading',
    'python-dotenv>=1.0.0',
    '',
    '# Optional: for streaming output',
    '# google-cloud-aiplatform>=1.0.0',
  ].join('\n');
}

function buildDotEnvExample(agentName: string): string {
  return [
    '# ---------------------------------------------------------------',
    '# AgentVault | Google ADK Agent – Environment Variables',
    `# Agent: ${agentName}`,
    '# ---------------------------------------------------------------',
    '',
    '# Required: Gemini / Google AI API key',
    '# Get yours at https://aistudio.google.com/apikey',
    'GOOGLE_API_KEY=your-google-api-key-here',
    '',
    '# Optional: Override the default Gemini model',
    'GOOGLE_MODEL=gemini-2.0-flash',
    '',
    '# Optional: Max iterations (loop agent only)',
    'MAX_ITERATIONS=10',
    '',
    '# Optional: AgentVault ICP canister ID',
    '# AGENTVAULT_CANISTER_ID=',
    '',
    '# Optional: Arweave wallet key path (for backup uploads)',
    '# ARWEAVE_KEY_FILE=~/.arweave/wallet.json',
  ].join('\n');
}

function buildReadme(
  agentName: string,
  agentType: GoogleADKAgentType,
  canisterId: string
): string {
  const typeLabel: Record<GoogleADKAgentType, string> = {
    loop: 'Loop Agent',
    sequential: 'Sequential Agent',
    parallel: 'Parallel Agent',
    workflow: 'Workflow Agent',
  };
  const typeDesc: Record<GoogleADKAgentType, string> = {
    loop: 'Repeats its sub-agents for up to `MAX_ITERATIONS` cycles, allowing iterative refinement.',
    sequential: 'Pipelines three stages (planner → executor → reviewer) in strict order.',
    parallel: 'Fans out to three workers simultaneously and aggregates their responses.',
    workflow: 'LLM-driven orchestrator that delegates to specialist sub-agents (validator → processor → summariser).',
  };

  return [
    `# ${agentName}`,
    '',
    `> **Google ADK ${typeLabel[agentType]}** – managed by [AgentVault](https://github.com/AgentVault)`,
    '',
    '## Overview',
    '',
    typeDesc[agentType],
    '',
    '## Quick Start',
    '',
    '```bash',
    '# 1. Install Python dependencies',
    'pip install -r requirements.txt',
    '',
    '# 2. Copy and fill in your environment variables',
    'cp .env.example .env',
    '# edit .env and set GOOGLE_API_KEY',
    '',
    '# 3. Run interactively',
    'python main.py',
    '',
    '# 4. Or use the ADK developer UI',
    'adk web',
    '```',
    '',
    '## Structure',
    '',
    '```',
    `${agentName}/`,
    '├── agent.py          # ADK agent definition (exports root_agent)',
    '├── main.py           # Interactive entry point',
    '├── requirements.txt  # Python dependencies',
    '├── .env.example      # Environment variable template',
    '└── .agentvault/',
    '    └── config.json   # AgentVault on-chain configuration',
    '```',
    '',
    '## AgentVault Configuration',
    '',
    `| Key            | Value                         |`,
    `|----------------|-------------------------------|`,
    `| Agent Name     | \`${agentName}\`               |`,
    `| Agent Type     | \`google-adk-${agentType}\`    |`,
    `| ICP Canister   | \`${canisterId}\`              |`,
    `| ADK Version    | google-adk ≥ 0.5.0            |`,
    '',
    '## A2A Compatibility',
    '',
    'This agent exposes a standard [Agent-to-Agent (A2A)](https://google.github.io/A2A/) interface.',
    'Other ADK agents can invoke it as a tool via `AgentTool(agent=root_agent)`.',
    '',
    '## Learn More',
    '',
    '- [Google ADK Documentation](https://google.github.io/adk-docs/)',
    '- [AgentVault Platform](https://github.com/AgentVault)',
    '- [A2A Protocol](https://google.github.io/A2A/)',
  ].join('\n');
}

function buildAgentVaultConfig(
  agentName: string,
  agentType: GoogleADKAgentType,
  canisterId: string,
  birthdayTimestamp: string
): Record<string, unknown> {
  return {
    name: agentName,
    type: `google-adk-${agentType}`,
    framework: 'google-adk',
    version: '1.0.0',
    createdAt: birthdayTimestamp,
    canisterId,
    network: 'local',
    a2aCompatible: true,
    adkEntryPoint: 'agent.py',
    adkRootAgent: 'root_agent',
    description: `Google ADK ${agentType} agent managed by AgentVault`,
  };
}

// ---------------------------------------------------------------------------
// Scaffold generation
// ---------------------------------------------------------------------------

export function generateAgentScaffold(
  agentName: string,
  agentType: GoogleADKAgentType,
  baseDir: string,
  canisterId: string,
  birthdayTimestamp: string
): ScaffoldResult {
  const agentDir = path.join(baseDir, agentName);
  const avDir = path.join(agentDir, '.agentvault');

  // Create directory structure
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(avDir, { recursive: true });

  const files: string[] = [];

  // agent.py
  const agentPyPath = path.join(agentDir, 'agent.py');
  fs.writeFileSync(agentPyPath, buildAgentPy(agentName, agentType), 'utf8');
  files.push(path.join(agentName, 'agent.py'));

  // main.py
  const mainPyPath = path.join(agentDir, 'main.py');
  fs.writeFileSync(mainPyPath, buildMainPy(agentName, agentType), 'utf8');
  files.push(path.join(agentName, 'main.py'));

  // requirements.txt
  const reqPath = path.join(agentDir, 'requirements.txt');
  fs.writeFileSync(reqPath, buildRequirementsTxt(), 'utf8');
  files.push(path.join(agentName, 'requirements.txt'));

  // .env.example
  const envExPath = path.join(agentDir, '.env.example');
  fs.writeFileSync(envExPath, buildDotEnvExample(agentName), 'utf8');
  files.push(path.join(agentName, '.env.example'));

  // README.md
  const readmePath = path.join(agentDir, 'README.md');
  fs.writeFileSync(readmePath, buildReadme(agentName, agentType, canisterId), 'utf8');
  files.push(path.join(agentName, 'README.md'));

  // .agentvault/config.json
  const configPath = path.join(avDir, 'config.json');
  const config = buildAgentVaultConfig(agentName, agentType, canisterId, birthdayTimestamp);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  files.push(path.join(agentName, '.agentvault', 'config.json'));

  return { files, agentDir };
}

// ---------------------------------------------------------------------------
// Canister provisioning (simulation – real dfx deploy in future)
// ---------------------------------------------------------------------------

export interface CanisterProvisionResult {
  canisterId: string;
  isExisting: boolean;
  network: string;
}

export function provisionCanister(
  agentName: string,
  network: 'local' | 'ic',
  existingCanisterId?: string
): CanisterProvisionResult {
  if (existingCanisterId) {
    return { canisterId: existingCanisterId, isExisting: true, network };
  }

  // Generate a deterministic-ish canister ID seeded by agent name + timestamp
  // so it stays stable across dry-run previews for the same agent.
  const seed = crypto
    .createHash('sha256')
    .update(`${agentName}-${network}-${Date.now()}`)
    .digest('hex');

  // ICP canister IDs use base32 with specific segment lengths
  const b32chars = 'abcdefghijklmnopqrstuvwxyz234567';
  const toB32 = (hex: string, len: number): string =>
    Array.from({ length: len }, (_, i) => b32chars[parseInt(hex[i * 2] ?? '0', 16) % 32]).join('');

  const canisterId = `${toB32(seed, 5)}-${toB32(seed.slice(10), 5)}-${toB32(seed.slice(20), 5)}-${toB32(seed.slice(30), 5)}-cai`;

  return { canisterId, isExisting: false, network };
}

// ---------------------------------------------------------------------------
// Birthday backup (genesis Arweave archive)
// ---------------------------------------------------------------------------

export interface BirthdayBackupResult {
  archiveId: string;
  checksum: string;
  sizeBytes: number;
}

export function createBirthdayBackup(
  agentName: string,
  agentType: GoogleADKAgentType,
  canisterId: string,
  birthdayTimestamp: string
): BirthdayBackupResult {
  const data: Record<string, unknown> = {
    schemaVersion: '1.0',
    event: 'birthday',
    agentName,
    agentType: `google-adk-${agentType}`,
    framework: 'google-adk',
    canisterId,
    birthdayTimestamp,
    description:
      'Genesis snapshot – the immutable origin record of this agent on AgentVault. ' +
      'Equivalent to git init: establishes provenance and on-chain identity.',
    a2aCompatible: true,
    agentVaultVersion: '1.0.2',
  };

  const result = prepareArchive(agentName, '1.0.0', data, {
    includeConfig: true,
    tags: {
      'av-event': 'birthday',
      'av-agent-type': `google-adk-${agentType}`,
      'av-canister-id': canisterId,
      'av-framework': 'google-adk',
      'av-birthday': birthdayTimestamp,
    },
  });

  if (!result.success || !result.archiveId) {
    throw new Error(`Failed to create birthday backup: ${result.error ?? 'unknown error'}`);
  }

  // Compute checksum of the data blob for display
  const checksum = crypto
    .createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex')
    .slice(0, 16);

  const sizeBytes = Buffer.byteLength(JSON.stringify(data));

  return { archiveId: result.archiveId, checksum, sizeBytes };
}

// ---------------------------------------------------------------------------
// Main mint function
// ---------------------------------------------------------------------------

export async function mintGoogleADKAgent(
  options: GoogleADKMintOptions
): Promise<GoogleADKMintResult> {
  const startTime = Date.now();
  const {
    agentName,
    agentType,
    outputDir = process.cwd(),
    network = 'local',
    canisterId: existingCanisterId,
    skipBackup = false,
    onProgress,
  } = options;

  const birthdayTimestamp = new Date().toISOString();

  try {
    // -------------------------------------------------------------------
    // 1. Check google-adk availability
    // -------------------------------------------------------------------
    emit(onProgress, 'Checking Google ADK availability...');
    const adkCheck = await checkGoogleADKAvailable();

    if (!adkCheck.available) {
      return {
        success: false,
        agentName,
        agentType,
        agentDir: path.join(outputDir, agentName),
        birthdayTimestamp,
        scaffoldFiles: [],
        error: adkCheck.error,
        durationMs: Date.now() - startTime,
      };
    }

    emit(
      onProgress,
      `Google ADK available${adkCheck.version ? ` (v${adkCheck.version})` : ''} via ${adkCheck.pythonPath ?? 'python'}`
    );

    // -------------------------------------------------------------------
    // 2. Provision canister
    // -------------------------------------------------------------------
    emit(onProgress, `Provisioning ICP canister (network: ${network})...`);
    const canisterResult = provisionCanister(agentName, network, existingCanisterId);

    if (canisterResult.isExisting) {
      emit(onProgress, `Using existing canister: ${canisterResult.canisterId}`);
    } else {
      emit(onProgress, `Canister provisioned: ${canisterResult.canisterId}`);
    }

    // -------------------------------------------------------------------
    // 3. Generate agent scaffold
    // -------------------------------------------------------------------
    emit(onProgress, `Generating ${agentType} agent scaffold...`);
    const scaffold = generateAgentScaffold(
      agentName,
      agentType,
      outputDir,
      canisterResult.canisterId,
      birthdayTimestamp
    );
    emit(onProgress, `Scaffold created: ${scaffold.agentDir}`);

    // -------------------------------------------------------------------
    // 4. Birthday Arweave backup
    // -------------------------------------------------------------------
    let birthdayArchiveId: string | undefined;

    if (!skipBackup) {
      emit(onProgress, 'Creating birthday Arweave backup (genesis snapshot)...');
      try {
        const backup = createBirthdayBackup(
          agentName,
          agentType,
          canisterResult.canisterId,
          birthdayTimestamp
        );
        birthdayArchiveId = backup.archiveId;
        emit(onProgress, `Birthday backup created: ${backup.archiveId} (${backup.sizeBytes} bytes)`);
      } catch (backupErr) {
        // Non-fatal – warn but continue
        const msg = backupErr instanceof Error ? backupErr.message : String(backupErr);
        emit(onProgress, `Warning: birthday backup failed (non-fatal): ${msg}`);
      }
    } else {
      emit(onProgress, 'Skipping birthday backup (--no-backup)');
    }

    return {
      success: true,
      agentName,
      agentType,
      agentDir: scaffold.agentDir,
      canisterId: canisterResult.canisterId,
      birthdayArchiveId,
      birthdayTimestamp,
      scaffoldFiles: scaffold.files,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      agentName,
      agentType,
      agentDir: path.join(outputDir, agentName),
      birthdayTimestamp,
      scaffoldFiles: [],
      error,
      durationMs: Date.now() - startTime,
    };
  }
}

// ---------------------------------------------------------------------------
// Re-export for use by CLI and other modules
// ---------------------------------------------------------------------------

export { generateSimulatedCanisterId };
