// Pure Token-Based Telemetry for QuicKlip
// Issue #2: Raw input/output token tracking per agent
// No automatic dollar values - manual avg $/1k toggle only

export interface TokenUsage {
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: Date;
  provider: string;
  model: string;
}

export class TokenTelemetry {
  private usageLog: TokenUsage[] = [];

  recordUsage(usage: TokenUsage) {
    this.usageLog.push(usage);
    // TODO: persist to DB/Redis for dashboard
    console.log(`[Telemetry] Agent ${usage.agentId}: ${usage.inputTokens} in / ${usage.outputTokens} out`);
  }

  getAgentUsage(agentId: string, period?: 'day' | 'week' | 'month') {
    // TODO: query logic
    return this.usageLog.filter(u => u.agentId === agentId);
  }

  // Rate limiting based on tokens only
  checkRateLimit(agentId: string, tokensUsed: number): boolean {
    // TODO: implement per-agent token quota
    return true;
  }
}

// Integration point with Universal Adapter (from #1)
// Owner can set manual avg $/1k in adapter config if desired

export const tokenTelemetry = new TokenTelemetry();
