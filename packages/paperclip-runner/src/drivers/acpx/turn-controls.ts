export type AcpxTurnControlMode = "steer" | "follow_up";
export interface AcpxTurnControl {
  turnId: string;
  controlId: string;
  mode: AcpxTurnControlMode;
  message: string;
}

/** Closed, bounded mutation envelope; a follow-up never becomes a cancellation. */
export function parseAcpxTurnControl(input: Record<string, unknown>): AcpxTurnControl {
  if (Object.keys(input).some(key => !["turnId", "controlId", "mode", "message"].includes(key))) {
    throw new Error("ACP turn control contains unknown fields");
  }
  const identity = (value: unknown, limit: number, name: string): string => {
    if (typeof value !== "string" || value.length > limit || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
      throw new Error(`ACP ${name} is invalid`);
    }
    return value;
  };
  if (input.mode !== "steer" && input.mode !== "follow_up") throw new Error("ACP turn control mode is invalid");
  if (typeof input.message !== "string" || !input.message.trim() || input.message.includes("\0")
    || Buffer.byteLength(input.message, "utf8") > 65_536) throw new Error("ACP turn control message is invalid");
  return {
    turnId: identity(input.turnId, 240, "turn id"),
    controlId: identity(input.controlId, 160, "control id"),
    mode: input.mode,
    message: input.message,
  };
}

/** Reserve before dispatch and retain ambiguous attempts until the turn ends. */
export class AcpxTurnControlLedger {
  #turnId: string | null = null;
  #attempts = new Set<string>();
  begin(turnId: string): void { this.#turnId = turnId; this.#attempts.clear(); }
  reserve(control: AcpxTurnControl, activeTurnId: string | null): void {
    if (control.turnId !== activeTurnId || this.#turnId !== activeTurnId) throw new Error("ACP turn control names a stale or inactive turn");
    if (this.#attempts.has(control.controlId)) throw new Error("ACP turn control was already attempted");
    if (this.#attempts.size >= 1024) throw new Error("ACP turn control limit reached");
    this.#attempts.add(control.controlId);
  }
}
