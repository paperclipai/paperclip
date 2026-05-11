import type { PipelineRun, PipelineRunStatus, PipelineStage, StageStatus } from "./types.js";

interface DbClient {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount?: number } | void>;
}

export class StateMachine {
  private db: DbClient;

  constructor(db: DbClient) {
    this.db = db;
  }

  private table(name: string): string {
    return `${this.db.namespace}.${name}`;
  }

  private activeLocks = new Set<string>();

  async tryAdvisoryLock(runId: string): Promise<boolean> {
    if (this.activeLocks.has(runId)) return false;
    this.activeLocks.add(runId);
    return true;
  }

  async releaseAdvisoryLock(runId: string): Promise<void> {
    this.activeLocks.delete(runId);
  }

  async claimStageForDispatch(stageRowId: string): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET status = 'running', started_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [stageRowId],
    );
    return (result as { rowCount?: number })?.rowCount !== 0;
  }

  async createRun(input: {
    id: string;
    companyId: string;
    parentIssueId: string;
    pipelineName: string;
    pipelineVersion: number;
    pipelineYaml: string;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("pipeline_runs")} (id, company_id, parent_issue_id, pipeline_name, pipeline_version, pipeline_yaml)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.id, input.companyId, input.parentIssueId, input.pipelineName, input.pipelineVersion, input.pipelineYaml],
    );
  }

  async updateRunStatus(runId: string, status: PipelineRunStatus): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_runs")} SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, runId],
    );
  }

  async createStage(input: { id: string; pipelineRunId: string; stageId: string }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("pipeline_stages")} (id, pipeline_run_id, stage_id)
       VALUES ($1, $2, $3)`,
      [input.id, input.pipelineRunId, input.stageId],
    );
  }

  async updateStageStatus(stageRowId: string, status: StageStatus): Promise<void> {
    const isTerminal = status === "completed" || status === "failed" || status === "skipped";

    let sql = `UPDATE ${this.table("pipeline_stages")} SET status = $1`;
    if (isTerminal) sql += `, completed_at = NOW()`;
    sql += ` WHERE id = $2`;

    await this.db.execute(sql, [status, stageRowId]);
  }

  async setStageOutput(stageRowId: string, output: Record<string, unknown>): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET output = $1::jsonb WHERE id = $2`,
      [JSON.stringify(output), stageRowId],
    );
  }

  async setStageError(stageRowId: string, error: string): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET error = $1 WHERE id = $2`,
      [error, stageRowId],
    );
  }

  async incrementRetryCount(stageRowId: string): Promise<number> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET retry_count = retry_count + 1, status = 'pending', started_at = NULL, completed_at = NULL WHERE id = $1`,
      [stageRowId],
    );
    const rows = await this.db.query<{ retry_count: number }>(
      `SELECT retry_count FROM ${this.table("pipeline_stages")} WHERE id = $1`,
      [stageRowId],
    );
    return rows[0]?.retry_count ?? 0;
  }

  async resetDownstreamStages(pipelineRunId: string, afterStageId: string, allStages: string[], adjacency: Map<string, string[]>): Promise<void> {
    const downstream = this.getDownstreamStageIds(afterStageId, allStages, adjacency);
    if (downstream.length === 0) return;

    const placeholders = downstream.map((_, i) => `$${i + 2}`).join(", ");
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET status = 'pending', output = NULL, error = NULL, started_at = NULL, completed_at = NULL
       WHERE pipeline_run_id = $1 AND stage_id IN (${placeholders})`,
      [pipelineRunId, ...downstream],
    );
  }

  private getDownstreamStageIds(afterStageId: string, allStageIds: string[], adjacency: Map<string, string[]>): string[] {
    const downstream = new Set<string>();
    const queue = [afterStageId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const stageId of allStageIds) {
        if (downstream.has(stageId)) continue;
        const deps = adjacency.get(stageId) ?? [];
        if (deps.includes(current)) {
          downstream.add(stageId);
          queue.push(stageId);
        }
      }
    }
    return [...downstream];
  }

  async getRunStages(pipelineRunId: string): Promise<PipelineStage[]> {
    const rows = await this.db.query<{
      id: string;
      pipeline_run_id: string;
      stage_id: string;
      sub_issue_id: string | null;
      status: StageStatus;
      retry_count: number;
      output: Record<string, unknown> | null;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>(
      `SELECT id, pipeline_run_id, stage_id, sub_issue_id, status, retry_count, output, error, started_at, completed_at
       FROM ${this.table("pipeline_stages")} WHERE pipeline_run_id = $1`,
      [pipelineRunId],
    );
    return rows.map((r) => ({
      id: r.id,
      pipelineRunId: r.pipeline_run_id,
      stageId: r.stage_id,
      subIssueId: r.sub_issue_id,
      status: r.status,
      retryCount: r.retry_count,
      output: r.output,
      error: r.error,
      startedAt: r.started_at ? new Date(r.started_at) : null,
      completedAt: r.completed_at ? new Date(r.completed_at) : null,
    }));
  }

  async getActiveRunForIssue(parentIssueId: string, companyId: string): Promise<PipelineRun | null> {
    const rows = await this.db.query<{
      id: string;
      company_id: string;
      parent_issue_id: string;
      pipeline_name: string;
      pipeline_version: number;
      pipeline_yaml: string;
      status: PipelineRunStatus;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT * FROM ${this.table("pipeline_runs")}
       WHERE parent_issue_id = $1 AND company_id = $2 AND status = 'running'
       LIMIT 1`,
      [parentIssueId, companyId],
    );

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      companyId: r.company_id,
      parentIssueId: r.parent_issue_id,
      pipelineName: r.pipeline_name,
      pipelineVersion: r.pipeline_version,
      pipelineYaml: r.pipeline_yaml,
      status: r.status,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  async getStageBySubIssueId(subIssueId: string): Promise<(PipelineStage & { pipelineRunId: string }) | null> {
    const rows = await this.db.query<{
      id: string;
      pipeline_run_id: string;
      stage_id: string;
      sub_issue_id: string | null;
      status: StageStatus;
      retry_count: number;
      output: Record<string, unknown> | null;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>(
      `SELECT * FROM ${this.table("pipeline_stages")} WHERE sub_issue_id = $1 LIMIT 1`,
      [subIssueId],
    );

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      pipelineRunId: r.pipeline_run_id,
      stageId: r.stage_id,
      subIssueId: r.sub_issue_id,
      status: r.status,
      retryCount: r.retry_count,
      output: r.output,
      error: r.error,
      startedAt: r.started_at ? new Date(r.started_at) : null,
      completedAt: r.completed_at ? new Date(r.completed_at) : null,
    };
  }

  async setStageSubIssueId(stageRowId: string, subIssueId: string): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET sub_issue_id = $1 WHERE id = $2`,
      [subIssueId, stageRowId],
    );
  }

  async getRun(runId: string): Promise<PipelineRun | null> {
    const rows = await this.db.query<{
      id: string;
      company_id: string;
      parent_issue_id: string;
      pipeline_name: string;
      pipeline_version: number;
      pipeline_yaml: string;
      status: PipelineRunStatus;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT * FROM ${this.table("pipeline_runs")} WHERE id = $1 LIMIT 1`,
      [runId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      companyId: r.company_id,
      parentIssueId: r.parent_issue_id,
      pipelineName: r.pipeline_name,
      pipelineVersion: r.pipeline_version,
      pipelineYaml: r.pipeline_yaml,
      status: r.status,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }
}
