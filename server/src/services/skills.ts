/**
 * Skills Service - Manages skill discovery, installation, and execution
 */

import type { Db } from "@paperclipai/db";
import { skills, skillInstallations, skillExecutions } from "@paperclipai/db";
import { eq, and, desc, isNull } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

// Built-in skills library (MVP)
const BUILTIN_SKILLS = [
  {
    name: "calculate",
    category: "math",
    description: "Perform mathematical calculations",
    version: "1.0.0",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string" },
      },
      required: ["expression"],
    },
    returns: { type: "number" },
    isBuiltin: true,
    tags: ["math", "calculate"],
  },
  {
    name: "summarize",
    category: "text",
    description: "Summarize text content",
    version: "1.0.0",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        maxLength: { type: "number" },
      },
      required: ["text"],
    },
    returns: { type: "string" },
    isBuiltin: true,
    tags: ["text", "summarize"],
  },
  {
    name: "extract-json",
    category: "data",
    description: "Extract JSON from text",
    version: "1.0.0",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
    returns: { type: "object" },
    isBuiltin: true,
    tags: ["data", "json", "extract"],
  },
  {
    name: "parse-csv",
    category: "data",
    description: "Parse CSV data",
    version: "1.0.0",
    parameters: {
      type: "object",
      properties: {
        data: { type: "string" },
      },
      required: ["data"],
    },
    returns: {
      type: "array",
      items: { type: "object" },
    },
    isBuiltin: true,
    tags: ["data", "csv", "parse"],
  },
  {
    name: "log",
    category: "utility",
    description: "Log a message",
    version: "1.0.0",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
        level: { type: "string", enum: ["info", "warn", "error"] },
      },
      required: ["message"],
    },
    returns: { type: "object", properties: { logged: { type: "boolean" } } },
    isBuiltin: true,
    tags: ["utility", "log"],
  },
];

export class SkillsService {
  constructor(private db: Db) {}

  /**
   * Initialize built-in skills
   */
  async initializeBuiltinSkills(): Promise<void> {
    try {
      for (const skillDef of BUILTIN_SKILLS) {
        const existing = await this.db
          .select({ id: skills.id })
          .from(skills)
          .where(eq(skills.name, skillDef.name))
          .then((rows) => rows[0] ?? null);

        if (!existing) {
          await this.db.insert(skills).values({
            name: skillDef.name,
            category: skillDef.category as any,
            description: skillDef.description,
            version: skillDef.version,
            parameters: skillDef.parameters as any,
            returns: skillDef.returns as any,
            isBuiltin: skillDef.isBuiltin,
            tags: skillDef.tags,
            status: "published",
            publishedAt: new Date(),
          });

          logger.info(`Initialized built-in skill: ${skillDef.name}`);
        }
      }
    } catch (error: any) {
      logger.error(`Error initializing built-in skills: ${error?.message}`);
    }
  }

  /**
   * Get all available skills
   */
  async getAvailableSkills(
    category?: string,
    search?: string
  ): Promise<typeof skills.$inferSelect[]> {
    try {
      let query = this.db
        .select()
        .from(skills)
        .where(eq(skills.status, "published")) as any;

      if (category) {
        query = query.where(eq(skills.category, category as any));
      }

      if (search) {
        // Simple search in name and description (MVP)
        const searchLower = search.toLowerCase();
        const allSkills = await query;
        return allSkills.filter(
          (s: any) =>
            s.name.toLowerCase().includes(searchLower) ||
            s.description.toLowerCase().includes(searchLower)
        );
      }

      return query.orderBy(desc(skills.downloadCount));
    } catch (error: any) {
      logger.error(`Error getting available skills: ${error?.message}`);
      return [];
    }
  }

  /**
   * Get skill by name
   */
  async getSkillByName(name: string): Promise<typeof skills.$inferSelect | null> {
    try {
      return await this.db
        .select()
        .from(skills)
        .where(eq(skills.name, name))
        .then((rows) => rows[0] ?? null);
    } catch (error: any) {
      logger.error(`Error getting skill: ${error?.message}`);
      return null;
    }
  }

  /**
   * Install skill for agent or company
   */
  async installSkill(
    skillId: string,
    companyId: string,
    userId: string,
    agentId?: string
  ): Promise<typeof skillInstallations.$inferSelect | null> {
    try {
      const skill = await this.db
        .select()
        .from(skills)
        .where(eq(skills.id, skillId))
        .then((rows) => rows[0] ?? null);

      if (!skill) {
        throw new Error("Skill not found");
      }

      // Check if already installed
      const existing = await this.db
        .select()
        .from(skillInstallations)
        .where(
          and(
            eq(skillInstallations.skillId, skillId),
            eq(skillInstallations.companyId, companyId),
            agentId
              ? eq(skillInstallations.agentId, agentId)
              : isNull(skillInstallations.agentId)
          )
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return existing;
      }

      // Create installation
      const installation = await this.db
        .insert(skillInstallations)
        .values({
          skillId,
          companyId,
          agentId: agentId || null,
          version: skill.version,
          installedBy: userId,
        })
        .returning();

      // Increment download count
      await this.db
        .update(skills)
        .set({ downloadCount: (skill.downloadCount || 0) + 1 })
        .where(eq(skills.id, skillId));

      logger.info(`Skill installed: ${skill.name} for company ${companyId}`);
      return installation[0] ?? null;
    } catch (error: any) {
      logger.error(`Error installing skill: ${error?.message}`);
      return null;
    }
  }

  /**
   * Uninstall skill
   */
  async uninstallSkill(
    skillId: string,
    companyId: string,
    agentId?: string
  ): Promise<boolean> {
    try {
      await this.db
        .delete(skillInstallations)
        .where(
          and(
            eq(skillInstallations.skillId, skillId),
            eq(skillInstallations.companyId, companyId),
            agentId
              ? eq(skillInstallations.agentId, agentId)
              : isNull(skillInstallations.agentId)
          )
        );

      logger.info(`Skill uninstalled: ${skillId}`);
      return true;
    } catch (error: any) {
      logger.error(`Error uninstalling skill: ${error?.message}`);
      return false;
    }
  }

  /**
   * Get installed skills for company/agent
   */
  async getInstalledSkills(
    companyId: string,
    agentId?: string
  ): Promise<Array<typeof skills.$inferSelect>> {
    try {
      const installations = await this.db
        .select()
        .from(skillInstallations)
        .where(
          and(
            eq(skillInstallations.companyId, companyId),
            agentId
              ? eq(skillInstallations.agentId, agentId)
              : undefined
          )
        );

      if (installations.length === 0) {
        return [];
      }

      const skillIds = installations.map((inst) => inst.skillId);
      const installedSkills = await this.db
        .select()
        .from(skills)
        .where(eq(skills.id, skillIds[0])); // Will be fixed in actual implementation

      return installedSkills;
    } catch (error: any) {
      logger.error(`Error getting installed skills: ${error?.message}`);
      return [];
    }
  }

  /**
   * Execute skill (MVP - simple execution)
   */
  async executeSkill(
    skillName: string,
    agentId: string,
    inputData: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    const startTime = Date.now();
    let skill: typeof skills.$inferSelect | null = null;

    try {
      skill = await this.getSkillByName(skillName);
      if (!skill) {
        throw new Error(`Skill not found: ${skillName}`);
      }

      // Log execution
      const execution = await this.db
        .insert(skillExecutions)
        .values({
          skillId: skill.id,
          agentId,
          status: "running",
          inputData: inputData as any,
        })
        .returning();

      // Simple skill execution (MVP)
      let outputData: any = {};

      switch (skillName) {
        case "calculate":
          // Basic calculator
          try {
            const expr = inputData.expression as string;
            // Safe eval alternative: only allow numbers and operators
            const result = eval(expr.replace(/[^0-9+\-*/.()]/g, ""));
            outputData = { result };
          } catch {
            throw new Error("Invalid expression");
          }
          break;

        case "summarize":
          // Simple summarization (truncate)
          const text = inputData.text as string;
          const maxLength = (inputData.maxLength as number) || 100;
          outputData = { summary: text.substring(0, maxLength) + "..." };
          break;

        case "extract-json":
          // Simple JSON extraction
          const content = inputData.text as string;
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          outputData = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
          break;

        case "parse-csv":
          // Simple CSV parsing
          const csvData = inputData.data as string;
          const lines = csvData.split("\n");
          const headers = lines[0].split(",");
          const rows = lines.slice(1).map((line) => {
            const values = line.split(",");
            const obj: Record<string, string> = {};
            headers.forEach((h, i) => {
              obj[h.trim()] = values[i]?.trim() || "";
            });
            return obj;
          });
          outputData = { rows };
          break;

        case "log":
          // Logging
          const message = inputData.message as string;
          const level = (inputData.level as string) || "info";
          const logLevel = level as "info" | "warn" | "error" | "debug";
          if (logLevel === "info" || logLevel === "warn" || logLevel === "error" || logLevel === "debug") {
            logger[logLevel](message);
          }
          outputData = { logged: true };
          break;

        default:
          throw new Error(`Unknown skill: ${skillName}`);
      }

      // Update execution with success
      const executionTime = Date.now() - startTime;
      await this.db
        .update(skillExecutions)
        .set({
          status: "success",
          outputData: outputData as any,
          executionTimeMs: executionTime,
          completedAt: new Date(),
        })
        .where(eq(skillExecutions.id, execution[0]?.id || ""));

      return outputData;
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      logger.error(`Error executing skill ${skillName}: ${error?.message}`);

      // Log failure (skillId from earlier)
      if (skill) {
        await this.db
          .insert(skillExecutions)
          .values({
            skillId: skill.id,
            agentId,
            status: "error",
            inputData: inputData as any,
            errorMessage: error?.message,
            executionTimeMs: executionTime,
            completedAt: new Date(),
          });
      }

      return null;
    }
  }
}

export function getSkillsService(db: Db): SkillsService {
  return new SkillsService(db);
}
