export interface NativeDiagnosticOwner {
  companyId: string;
  sessionScope: string;
  runId: string;
}

export interface NativeDiagnosticLease {
  retire(): void;
}

export type NativeIdleDiagnosticKind = "transport_close_requested" | "session_diagnostic";

type Sink = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
type Epoch = { owner: NativeDiagnosticOwner; sink?: Sink };
const sessions = new WeakMap<object, NativeSessionDiagnostics>();

export class NativeSessionDiagnostics {
  private active: Epoch | undefined;
  private lastOwner: NativeDiagnosticOwner;

  constructor(
    private readonly scope: Pick<NativeDiagnosticOwner, "companyId" | "sessionScope">,
    initialOwner: NativeDiagnosticOwner,
    private readonly idle: (owner: NativeDiagnosticOwner, kind: NativeIdleDiagnosticKind) => void,
    private readonly failed: (owner: NativeDiagnosticOwner) => void,
  ) {
    if (!initialOwner.runId || initialOwner.companyId !== scope.companyId || initialOwner.sessionScope !== scope.sessionScope)
      throw new Error("native_diagnostic_owner_scope_mismatch");
    this.lastOwner = { ...initialOwner };
  }

  activate(owner: NativeDiagnosticOwner, sink?: Sink): NativeDiagnosticLease {
    if (!owner.runId || owner.companyId !== this.scope.companyId || owner.sessionScope !== this.scope.sessionScope)
      throw new Error("native_diagnostic_owner_scope_mismatch");
    if (this.active && (this.active.owner.runId !== owner.runId || this.active.sink !== sink))
      throw new Error("native_diagnostic_owner_busy");
    const epoch: Epoch = this.active ?? { owner: { ...owner }, sink };
    this.active = epoch;
    this.lastOwner = epoch.owner;
    return {
      retire: () => { if (this.active === epoch) this.active = undefined; },
    };
  }

  bind(session: object): void {
    const existing = sessions.get(session);
    if (existing && existing !== this) throw new Error("native_diagnostic_session_already_bound");
    sessions.set(session, this);
  }

  private report(operation: () => void): void {
    try { operation(); }
    catch { process.emitWarning("Native session diagnostic reporting failed"); }
  }

  record(chunk: string): void {
    const epoch = this.active;
    if (!epoch?.sink) {
      const kind = chunk.startsWith("[paperclip-runner] runnerd diagnostic: runner transport close requested:")
        ? "transport_close_requested" : "session_diagnostic";
      this.report(() => this.idle(epoch?.owner ?? this.lastOwner, kind));
      return;
    }
    try {
      void epoch.sink("stderr", chunk).catch(() => this.report(() => this.failed(epoch.owner)));
    } catch {
      this.report(() => this.failed(epoch.owner));
    }
  }
}

export function nativeSessionDiagnostics(session: object): NativeSessionDiagnostics | undefined {
  return sessions.get(session);
}
