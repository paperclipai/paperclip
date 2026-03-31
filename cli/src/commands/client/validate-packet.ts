import { Command } from 'commander';
import process from 'process'; // Import process to set exitCode

// Define a simple interface for packet validation
interface Packet {
  title?: string;
  packetType?: string;
  executionIntent?: string;
  reviewPolicy?: string;
  needsReview?: boolean;
  status?: string;
  Ziel?: string;
  Scope?: string;
  targetFile?: string;
  targetFolder?: string;
  artifactKind?: string;
  doneWhen?: string;
  Annahmen?: string;
}

// Validation error codes for machine-readable output
const VALIDATION_ERROR_CODES = {
  MISSING_TITLE: "missing_title",
  MISSING_PACKET_TYPE: "missing_packet_type",
  MISSING_EXECUTION_INTENT: "missing_execution_intent",
  MISSING_STATUS: "missing_status",
  MISSING_DONE_WHEN: "missing_done_when",
  NEEDS_INPUT: "needs_input",
} as const;

type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[keyof typeof VALIDATION_ERROR_CODES];

// Placeholder for parsing packet data from arguments or stdin
// For now, we'll simulate receiving packet data.
// In a real CLI, this might involve reading from stdin or parsing command-line arguments.
async function getPacketData(): Promise<Packet> {
  // Simulate receiving a packet. This should be replaced with actual parsing logic.
  return {
    title: "Add paperclipai issue validate-packet command",
    packetType: "free_api",
    executionIntent: "implement",
    reviewPolicy: "required",
    needsReview: true,
    status: "todo",
    Ziel: "Implement a new command `validate-packet` in the `paperclipai` CLI for pre-launch validation.",
    Scope: "cli/src/commands/client/, cli/src/__tests__/, and cli/src/index.ts.",
    targetFile: "n/a",
    targetFolder: "cli/src/commands/client/",
    artifactKind: "multi_file_change",
    // Use template literal for multi-line string
    doneWhen: `- Command exists and is registered in cli/src/commands/client/
- Exits 0 for ready packet, 1 for not-ready packet
- Supports --json flag for machine-readable output
- TDD tests pass in cli/src/__tests__/
- Typecheck passes (pnpm -r typecheck)`,
    Annahmen: "no obvious blockers", // Simulate a "ready" Annahmen field
  };
}

async function validatePacket(
  issueId: string,
  options: { json?: boolean }
): Promise<void> {
  // For now, simulate getting packet data. In a real implementation,
  // this would fetch from the API using the issueId.
  const packet = await getPacketData();

  const reasonCodes: ValidationErrorCode[] = [];

  // Basic validation rules:
  if (!packet.title) {
    reasonCodes.push(VALIDATION_ERROR_CODES.MISSING_TITLE);
  }
  if (!packet.packetType) {
    reasonCodes.push(VALIDATION_ERROR_CODES.MISSING_PACKET_TYPE);
  }
  if (!packet.executionIntent) {
    reasonCodes.push(VALIDATION_ERROR_CODES.MISSING_EXECUTION_INTENT);
  }
  if (!packet.status) {
    reasonCodes.push(VALIDATION_ERROR_CODES.MISSING_STATUS);
  }
  if (!packet.doneWhen) {
    reasonCodes.push(VALIDATION_ERROR_CODES.MISSING_DONE_WHEN);
  }
  if (packet.Annahmen?.includes("[NEEDS INPUT]")) {
    reasonCodes.push(VALIDATION_ERROR_CODES.NEEDS_INPUT);
  }

  const isReady = reasonCodes.length === 0;

  if (options.json) {
    // Machine-readable JSON output as specified by reviewer
    const jsonOutput = isReady
      ? { status: "ready" as const }
      : { status: "not_ready" as const, reasonCodes };
    console.log(JSON.stringify(jsonOutput));
    process.exit(isReady ? 0 : 1);
  } else {
    // Human-readable output
    if (isReady) {
      console.log("Packet is ready for processing.");
      process.exit(0);
    } else {
      console.error("Packet validation failed:");
      reasonCodes.forEach((code) => console.error(`- ${code}`));
      process.exit(1);
    }
  }
}

export const validatePacketCommand = new Command()
  .name('validate-packet')
  .description('Validates a Paperclip packet for pre-launch readiness.')
  .argument('<id>', 'Issue ID to validate')
  .option('--json', 'Output results in JSON format.')
  .action(validatePacket);
