export type OwnerRef = {
  computerId: string;
  ownerId: string;
  generation: number;
};
export type ProcessClaim = {
  bootId: string;
  unitName: string;
  nonce: string;
  launchGeneration: number;
};
export interface Owner {
  id: string;
  generation: number;
  kind: "runner" | "viewer" | "file-operation";
  phase: "starting" | "active" | "warm" | "retiring" | "retired";
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  userId?: string;
  port: number;
  deadline: string | null;
  absoluteDeadline: string | null;
  process: ProcessClaim | null;
}
export interface Ledger {
  controllerId: string;
  status: "attaching" | "attached" | "detaching" | "detached";
  secretRef: {
    type: "secret_ref";
    secretId: string;
    version?: number | "latest";
  };
  owners: Owner[];
  placements: Record<string, { id: string; root: string; cwd: string }>;
  action: null | { kind: "stop"; id: string; providerStopId: string | null };
}
export interface ComputerRecord {
  id: string;
  companyId: string;
  environmentId: string;
  providerId: string;
  ledger: Ledger;
}
export class ComputerError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "conflict"
      | "forbidden"
      | "invalid"
      | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}
export function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new ComputerError("invalid", "Invalid computer resource identifier");
  return value;
}
export function timeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1000 ||
    value > 24 * 60 * 60 * 1000
  )
    throw new ComputerError(
      "invalid",
      "Computer timeout must be between one second and one day",
    );
  return value;
}
export function exactOwner(record: ComputerRecord, ref: OwnerRef): Owner {
  const owner = record.ledger.owners.find((o) => o.id === ref.ownerId);
  if (
    record.id !== ref.computerId ||
    !owner ||
    owner.generation !== ref.generation
  )
    throw new ComputerError("conflict", "Computer owner has been superseded");
  return owner;
}
export function nextPort(owners: Owner[]): number {
  const occupied = new Set(
    owners.filter((o) => o.phase !== "retired").map((o) => o.port),
  );
  for (let port = 43127; port < 44127; port++)
    if (!occupied.has(port)) return port;
  throw new ComputerError("conflict", "Computer has no available runner ports");
}
export function liveOwners(ledger: Ledger): Owner[] {
  return ledger.owners.filter((o) => o.phase !== "retired");
}
export function assertAdmission(ledger: Ledger): void {
  if (ledger.status !== "attached" || ledger.action)
    throw new ComputerError(
      "conflict",
      "Computer is connecting or settling a previous stop",
    );
}
export function expired(owner: Owner, now: Date): boolean {
  return (
    owner.phase !== "retired" &&
    owner.deadline !== null &&
    Date.parse(owner.deadline) <= now.getTime()
  );
}
