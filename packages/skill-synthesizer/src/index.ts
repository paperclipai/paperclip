import { Client } from "pg";
import { knowledgeChunks, knowledgeTopics } from "@paperclipai/db/src/schema/knowledge.js";
import { eq, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg";
import * as schema from "@paperclipai/db/src/schema/index.js";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { buildSynthesisPrompt, buildEvalPrompt, getRepresentativeTasks } from "./prompts.js";
import type {
  SkillSynthesisResult,
  EvalResult,
  EvalTask,
  SynthesizedSkill,
  SkillStatus,
} from "./types.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SKILLS_BASE_PATH = ".agents/skills";

export class SkillSynthesizerService {
  private dbClient: Client | null = null;
  private db: ReturnType<typeof drizzle> | null = null;
  private anthropic: Anthropic | null = null;

  constructor() {
    if (ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    }
  }

  async initialize(): Promise<void> {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    this.dbClient = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    await this.dbClient.connect();

    this.db = drizzle(this.dbClient, { schema });
  }

  async close(): Promise<void> {
    if (this.dbClient) {
      await this.dbClient.end();
      this.dbClient = null;
      this.db = null;
    }
  }

  private ensureAnthropic(): Anthropic {
    if (!this.anthropic) {
      throw new Error("Anthropic client not initialized. Set ANTHROPIC_API_KEY environment variable.");
    }
    return this.anthropic;
  }

  async synthesizeTopic(topicSlug: string): Promise<SkillSynthesisResult> {
    if (!this.db) throw new Error("Service not initialized. Call initialize() first.");

    const topicResult = await this.db
      .select()
      .from(knowledgeTopics)
      .where(eq(knowledgeTopics.slug, topicSlug))
      .limit(1);

    if (topicResult.length === 0) {
      throw new Error(`Topic not found: ${topicSlug}`);
    }

    const topic = topicResult[0];

    const chunks = await this.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.topicId, topic.id))
      .orderBy(knowledgeChunks.chunkIndex);

    if (chunks.length === 0) {
      throw new Error(`No chunks found for topic: ${topicSlug}`);
    }

    const skillName = this.toSkillName(topic.name);
    const skillPath = path.join(SKILLS_BASE_PATH, skillName, "SKILL.md");

    const totalTokens = chunks.reduce((sum, c) => sum + (c.tokenEstimate || 0), 0);
    const chunksForSynthesis = totalTokens > 50000
      ? this.reduceChunksToTokenLimit(chunks, 50000)
      : chunks;

    const prompt = buildSynthesisPrompt(topic.name, topicSlug, chunksForSynthesis);

    const client = this.ensureAnthropic();
    const message = await client.messages.create({
      model: "claude-opus-4-2025-04-17",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const skillContent = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, skillContent, "utf-8");

    const usedTokens = message.usage.input_tokens + message.usage.output_tokens;

    await this.upsertSynthesizedSkill({
      topicId: topic.id,
      skillName,
      skillPath,
      status: "pending_eval",
    });

    return {
      skillName,
      skillPath,
      topicSlug,
      synthesisUsedTokens: usedTokens,
      chunksProcessed: chunksForSynthesis.length,
    };
  }

  async runEvalGate(skillPath: string, topicSlug: string): Promise<EvalResult> {
    const skillContent = await fs.readFile(skillPath, "utf-8");

    const tasks = getRepresentativeTasks(topicSlug);
    const client = this.ensureAnthropic();

    const evalResults: EvalTask[] = [];
    let totalTokens = 0;

    for (const task of tasks) {
      const prompt = buildEvalPrompt(topicSlug, skillContent, task);

      const message = await client.messages.create({
        model: "claude-opus-4-2025-04-17",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      totalTokens += message.usage.input_tokens + message.usage.output_tokens;

      const responseText = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          evalResults.push({
            task,
            score: parsed.score ?? 0,
            attempt: parsed.attempt ?? "",
          });
        } else {
          evalResults.push({ task, score: 0, attempt: "Failed to parse response" });
        }
      } catch {
        evalResults.push({ task, score: 0, attempt: "Parse error" });
      }
    }

    const averageScore = evalResults.reduce((sum, r) => sum + r.score, 0) / evalResults.length;

    return {
      skillPath,
      topicSlug,
      averageScore,
      tasks: evalResults,
      totalTokensUsed: totalTokens,
    };
  }

  async publishOrQueue(skillPath: string, evalScore: number): Promise<void> {
    if (!this.db) throw new Error("Service not initialized");

    const status: SkillStatus = evalScore >= 0.7 ? "published" : "needs_human_review";

    await this.db
      .update(schema.synthesizedSkills)
      .set({
        status,
        evalScore,
        evalTasks: sql`${JSON.stringify({})}::jsonb`,
        reviewedAt: new Date(),
      })
      .where(eq(schema.synthesizedSkills.skillPath, skillPath));
  }

  async getSkillByTopicSlug(topicSlug: string): Promise<SynthesizedSkill | null> {
    if (!this.db) throw new Error("Service not initialized");

    const topicResult = await this.db
      .select({ id: knowledgeTopics.id })
      .from(knowledgeTopics)
      .where(eq(knowledgeTopics.slug, topicSlug))
      .limit(1);

    if (topicResult.length === 0) return null;

    const skillResult = await this.db
      .select()
      .from(schema.synthesizedSkills)
      .where(eq(schema.synthesizedSkills.topicId, topicResult[0].id))
      .limit(1);

    if (skillResult.length === 0) return null;

    return this.mapToSynthesizedSkill(skillResult[0]);
  }

  async getAllSkills(): Promise<SynthesizedSkill[]> {
    if (!this.db) throw new Error("Service not initialized");

    const results = await this.db
      .select()
      .from(schema.synthesizedSkills)
      .orderBy(schema.synthesizedSkills.synthesizedAt);

    return results.map((r) => this.mapToSynthesizedSkill(r));
  }

  private async upsertSynthesizedSkill(params: {
    topicId: string;
    skillName: string;
    skillPath: string;
    status: SkillStatus;
  }): Promise<void> {
    if (!this.db) throw new Error("Service not initialized");

    const existing = await this.db
      .select({ id: schema.synthesizedSkills.id })
      .from(schema.synthesizedSkills)
      .where(eq(schema.synthesizedSkills.topicId, params.topicId))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(schema.synthesizedSkills)
        .set({
          skillName: params.skillName,
          skillPath: params.skillPath,
          status: params.status,
          synthesizedAt: new Date(),
        })
        .where(eq(schema.synthesizedSkills.id, existing[0].id));
    } else {
      await this.db.insert(schema.synthesizedSkills).values({
        topicId: params.topicId,
        skillName: params.skillName,
        skillPath: params.skillPath,
        status: params.status,
        evalScore: null,
        evalTasks: null,
        synthesizedAt: new Date(),
      });
    }
  }

  private mapToSynthesizedSkill(row: typeof schema.synthesizedSkills.$inferSelect): SynthesizedSkill {
    return {
      id: row.id,
      topicId: row.topicId,
      skillName: row.skillName,
      skillPath: row.skillPath,
      status: row.status as SkillStatus,
      evalScore: row.evalScore,
      evalTasks: row.evalTasks as EvalTask[] | null,
      synthesizedAt: row.synthesizedAt,
      reviewedAt: row.reviewedAt,
      reviewedBy: row.reviewedBy,
    };
  }

  private toSkillName(topicName: string): string {
    return topicName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private reduceChunksToTokenLimit(chunks: typeof knowledgeChunks.$inferSelect[], tokenLimit: number): typeof chunks {
    const result: typeof chunks = [];
    let totalTokens = 0;

    for (const chunk of chunks) {
      const chunkTokens = chunk.tokenEstimate || Math.ceil(chunk.content.length / 4);
      if (totalTokens + chunkTokens > tokenLimit && result.length > 0) {
        break;
      }
      result.push(chunk);
      totalTokens += chunkTokens;
    }

    return result;
  }
}