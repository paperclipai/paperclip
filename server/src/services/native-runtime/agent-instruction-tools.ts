import type { AgentInstructionCommitReceipt } from "@paperclipai/shared";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, notFound } from "../../errors.js";
import { agentInstructionRevisionService } from "../agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService } from "../agent-instruction-working-copies.js";
import { deriveBundleState } from "../agent-instructions.js";
import { agentService } from "../agents.js";
import type { AuthorizationActor } from "../authorization.js";

const target = { targetAgentId: z.string().uuid().optional() };
const entryFile = z.string().min(1).max(4096);
const baseRevisionId = z.string().uuid().nullable();
const schemas = {
  read_agent_instructions: z.object({ ...target, entryFile: entryFile.optional(), revisionId: z.string().uuid().optional() }).strict()
    .refine((input) => Boolean(input.entryFile) === Boolean(input.revisionId), "Historical reads require both entryFile and revisionId"),
  update_agent_instructions: z.object({ ...target, entryFile, content: z.string().max(1024 * 1024), baseRevisionId }).strict(),
  get_agent_instruction_history: z.object({ ...target, entryFile, cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  restore_agent_instructions: z.object({ ...target, entryFile, revisionId: z.string().uuid(), baseRevisionId: z.string().uuid() }).strict(),
};

export type AgentInstructionToolName = keyof typeof schemas;

/** Called only after the native authority validates its server-bound active run. */
export async function executeAgentInstructionTool(input: {
  db: Db;
  binding: { companyId: string; agentId: string; runId: string };
  tool: AgentInstructionToolName;
  arguments: unknown;
}) {
  // Never accept an actor, responsible user, company, or source run from tool JSON.
  const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId: input.binding.companyId, agentId: input.binding.agentId, runId: input.binding.runId };
  const service = agentInstructionRevisionService(input.db);
  const parse = <T>(schema: z.ZodType<T>): T => {
    const result = schema.safeParse(input.arguments);
    if (!result.success) throw badRequest("Invalid instruction tool arguments", result.error.flatten());
    return result.data;
  };
  const scope = (targetAgentId?: string) => ({ companyId: input.binding.companyId, agentId: targetAgentId ?? input.binding.agentId });
  const acknowledge = async (receipt: AgentInstructionCommitReceipt, targetAgentId?: string) => {
    // The commit is already durable. A failed baseline refresh keeps the old CAS
    // fence, so later cleanup preserves a conflict instead of overwriting it.
    await agentInstructionWorkingCopyService(input.db).acknowledgeExplicitSave({
      ...scope(targetAgentId), runId: input.binding.runId, entryFile: receipt.revision.entryFile,
      revisionId: receipt.revision.id, contentHash: receipt.revision.contentHash,
    }).catch(() => undefined);
    return receipt;
  };
  switch (input.tool) {
    case "read_agent_instructions": {
      const args = parse(schemas.read_agent_instructions);
      const target = scope(args.targetAgentId);
      if (args.entryFile && args.revisionId) return service.readRevision({ ...target, entryFile: args.entryFile, revisionId: args.revisionId }, actor);
      const snapshot = await service.readCurrent(target, actor);
      if (snapshot) return { ...snapshot, entryFile: snapshot.revision.entryFile };
      // An unseeded empty entry still needs its configured filename for the first CAS.
      const agent = await agentService(input.db).getById(target.agentId);
      if (!agent || agent.companyId !== target.companyId) throw notFound("Agent not found");
      return { entryFile: deriveBundleState(agent).entryFile, revision: null, content: null };
    }
    case "update_agent_instructions": {
      const args = parse(schemas.update_agent_instructions);
      const receipt = await service.commit({ ...scope(args.targetAgentId), entryFile: args.entryFile, content: args.content, baseRevisionId: args.baseRevisionId, source: "tool" }, actor);
      return acknowledge(receipt, args.targetAgentId);
    }
    case "get_agent_instruction_history": {
      const args = parse(schemas.get_agent_instruction_history);
      return service.history({ ...scope(args.targetAgentId), entryFile: args.entryFile, cursor: args.cursor, limit: args.limit }, actor);
    }
    case "restore_agent_instructions": {
      const args = parse(schemas.restore_agent_instructions);
      const receipt = await service.restore({ ...scope(args.targetAgentId), entryFile: args.entryFile, revisionId: args.revisionId, baseRevisionId: args.baseRevisionId }, actor);
      return acknowledge(receipt, args.targetAgentId);
    }
  }
}
