/**
 * Wire and domain types for the least-privilege Tailscale HTTPS host broker.
 *
 * The broker's only capability is adding and removing Paperclip-owned,
 * same-number HTTPS-to-loopback listeners. It never gains general Tailscale
 * administration. See PAP-17049 (plan) and PAP-17050 (threat-model verdict).
 *
 * SECURITY: every value that crosses the socket is untrusted. The Paperclip
 * caller, CLI output, Serve state, the registry, and listener metadata are all
 * treated as untrusted inputs.
 */

/** Supported broker protocol version. Requests on other versions are rejected. */
export const BROKER_PROTOCOL_VERSION = 1;

/** The protected primary route that must never change: `:443` -> loopback app. */
export const PROTECTED_PRIMARY_PORT = 443;
export const PROTECTED_PRIMARY_TARGET = "http://127.0.0.1:3100";

/**
 * Operator-declared ports the broker must never create, remove, or reclaim,
 * beyond the primary `:443` route (PAP-17285).
 *
 * WHY THIS EXISTS. The pre-existing "unknown/manual entries are never modified"
 * invariant is provenance-blind: it only protects entries the broker has no
 * lease for. It could not protect `42000/52000`, because the broker had itself
 * created them for a since-retired canary lane, so its registry still called
 * them owned. Operators had meanwhile reclassified those same ports as
 * must-preserve by observing `tailscale serve status` and failing to attribute
 * them to any live lane. Both views were internally consistent and they
 * disagreed, so a fully authorized, shape-valid, primary-preserving removal
 * destroyed a mapping that had been declared load-bearing — and no guard could
 * fire, because by every automated criterion it was healthy orphan reclamation.
 *
 * A protected port is therefore an *operator* assertion that outranks the
 * broker's own ownership record. It is the only machine-checkable way to make
 * "this mapping survives managed lane lifecycle" true rather than hoped-for.
 * Enforcement is fail-closed and defence-in-depth: refused during argv
 * construction, denied in reserve/expose/remove, excluded from the allocatable
 * allowlist, and asserted byte-unchanged across every before/after snapshot.
 */
export const PROTECTED_PRIMARY_PORTS: readonly number[] = [PROTECTED_PRIMARY_PORT];

export type BrokerOp = "reserve" | "expose" | "remove" | "list";

/** Peer credentials obtained from the OS for an accepted socket connection. */
export interface PeerCredentials {
  uid: number;
  gid: number;
  pid: number;
}

/** A single owned HTTPS-to-loopback listener the broker manages. */
export interface OwnedListener {
  purpose: "app" | "vite_hmr";
  /** Public HTTPS port == target loopback port (same-number invariant). */
  port: number;
}

/** Reserve an app/HMR pair before the managed backend starts listening. */
export interface ReserveRequest {
  op: "reserve";
  requestId: string;
  runtimeId: string;
  listeners: OwnedListener[];
}

/** Expose the listeners bound to a broker-issued reservation handle. */
export interface ExposeRequest {
  op: "expose";
  requestId: string;
  runtimeId: string;
  handle: string;
}

/** A remove request body. Requires a prior expose lease handle. */
export interface RemoveRequest {
  op: "remove";
  requestId: string;
  runtimeId: string;
  /** Unguessable handle returned by `expose`; binds ownership. */
  handle: string;
}

/** A list request body. Scoped to the caller; never returns lease handles. */
export interface ListRequest {
  op: "list";
  requestId: string;
}

export type BrokerRequest = ReserveRequest | ExposeRequest | RemoveRequest | ListRequest;

export interface ReserveResponseOk {
  ok: true;
  op: "reserve";
  requestId: string;
  /** Unguessable handle bound to peer, runtime, ports, and generation. */
  handle: string;
  reservedPorts: number[];
}

export interface ExposeResponseOk {
  ok: true;
  op: "expose";
  requestId: string;
  /** Lease handle required for a later `remove`. Never logged. */
  handle: string;
  publicPorts: number[];
}

export interface RemoveResponseOk {
  ok: true;
  op: "remove";
  requestId: string;
  removedPorts: number[];
}

export interface ListResponseOk {
  ok: true;
  op: "list";
  requestId: string;
  /** Caller-owned listeners only; no handles, no manual/unknown Serve state. */
  listeners: Array<{ runtimeId: string; port: number; purpose: OwnedListener["purpose"] }>;
}

export interface BrokerErrorResponse {
  ok: false;
  requestId: string | null;
  /** Stable machine code; never leaks command lines, paths, or secrets. */
  code: BrokerErrorCode;
  message: string;
}

export type BrokerResponse =
  | ReserveResponseOk
  | ExposeResponseOk
  | RemoveResponseOk
  | ListResponseOk
  | BrokerErrorResponse;

export type BrokerErrorCode =
  | "unsupported_version"
  | "malformed_request"
  | "unknown_operation"
  | "unauthorized_peer"
  | "invalid_runtime_id"
  | "invalid_port"
  | "port_not_allowlisted"
  | "listener_not_owned"
  // The three pre-flight listener predicates are reported separately. All of
  // them still deny, but collapsing them into one code made the deployed
  // failure undiagnosable: the discriminating text only ever reaches the
  // root-owned audit file, so the calling account cannot tell an absent
  // listener from a genuine off-loopback or wrong-owner violation. Naming the
  // failed predicate leaks nothing an attacker could not learn by probing the
  // port they already asked us to expose.
  | "listener_absent"
  | "listener_not_loopback"
  | "listener_ownership_mismatch"
  // The port carries a listener the broker cannot name (no socket identity), so
  // it cannot prove the socket it publishes is the socket it verified. Present
  // but unattributable is refused rather than treated as permission.
  | "listener_unattributable"
  // The verified socket was replaced between verification and publication. The
  // three predicates above cannot catch this on their own, because a different
  // process under the same managed-runtime UID satisfies all of them.
  | "listener_substituted"
  | "manual_mapping_present"
  // An operator-declared protected port was requested, or a protected entry
  // changed across a mutation. Distinct from `manual_mapping_present` (which is
  // about an *unleased* entry) because this denies even when the broker's own
  // registry says the port is ours to reclaim (PAP-17285).
  | "protected_port"
  | "protected_entry_violation"
  | "reservation_conflict"
  | "reservation_expired"
  | "primary_route_violation"
  | "invalid_handle"
  | "serve_parse_error"
  | "cli_error"
  | "cli_timeout"
  | "unexpected_serve_diff"
  | "quarantined"
  | "rate_limited"
  | "too_many_clients"
  | "internal_error";

/** A registry lease record persisted atomically under root ownership. */
export interface LeaseRecord {
  handle: string;
  runtimeId: string;
  /** Peer identity bound at expose time. */
  peerUid: number;
  peerGid: number;
  ports: number[];
  purposes: OwnedListener["purpose"][];
  /** Reserved before bind; exposed only after listener ownership is verified. */
  state: "reserved" | "exposed";
  /** Monotonic generation to defeat ABA remove/re-expose confusion. */
  generation: number;
  createdAtIso: string;
  /** Bounds leaked reservations when a caller crashes before backend start. */
  expiresAtIso: string | null;
}

/** Registry persisted to a root-owned 0600 file via temp+fsync+rename. */
export interface BrokerRegistry {
  version: 1;
  /** Node/boot identity; a change forces quarantine + operator reconciliation. */
  nodeIdentity: string;
  generationCounter: number;
  leases: LeaseRecord[];
  /** Ports quarantined after ambiguous/failed cleanup; never reused/auto-freed. */
  quarantinedPorts: number[];
}
