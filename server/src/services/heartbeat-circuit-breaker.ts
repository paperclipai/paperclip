interface CircuitBreakerState {
  failureCount: number;
  lastFailureAt: Date | null;
  state: "closed" | "open" | "half_open";
  openedAt: Date | null;
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxAttempts: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  halfOpenMaxAttempts: 1,
};

export class HeartbeatCircuitBreaker {
  private circuits = new Map<string, CircuitBreakerState>();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getState(agentId: string): CircuitBreakerState {
    let state = this.circuits.get(agentId);
    if (!state) {
      state = {
        failureCount: 0,
        lastFailureAt: null,
        state: "closed",
        openedAt: null,
      };
      this.circuits.set(agentId, state);
    }
    return state;
  }

  canExecute(agentId: string): { allowed: boolean; reason?: string } {
    const state = this.getState(agentId);

    if (state.state === "closed") {
      return { allowed: true };
    }

    if (state.state === "open") {
      const elapsed = Date.now() - (state.openedAt?.getTime() ?? 0);
      if (elapsed >= this.config.cooldownMs) {
        state.state = "half_open";
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `circuit_breaker.open (cooldown ${Math.ceil((this.config.cooldownMs - elapsed) / 1000)}s remaining)`,
      };
    }

    return { allowed: true };
  }

  recordSuccess(agentId: string): void {
    const state = this.getState(agentId);
    state.failureCount = 0;
    state.lastFailureAt = null;
    state.state = "closed";
    state.openedAt = null;
  }

  recordFailure(agentId: string): void {
    const state = this.getState(agentId);
    state.failureCount += 1;
    state.lastFailureAt = new Date();

    if (state.state === "half_open") {
      state.state = "open";
      state.openedAt = new Date();
      return;
    }

    if (state.failureCount >= this.config.failureThreshold) {
      state.state = "open";
      state.openedAt = new Date();
    }
  }

  getStats(agentId: string): CircuitBreakerState {
    return { ...this.getState(agentId) };
  }
}
