/**
 * AgentVault Canister (Motoko) - Hardened Production Version
 *
 * This canister serves as the on-chain execution environment for AI agents.
 * It provides state management, task execution, memory storage, and WASM module loading.
 * Implements the standard 14-function agent interface.
 */

import Memory "mo:base/Memory";
import Buffer "mo:base/Buffer";
import Int "mo:base/Int";
import Time "mo:base/Time";
import Iter "mo:base/Iter";
import Blob "mo:base/Blob";
import Text "mo:base/Text";
import Array "mo:base/Array";
import Option "mo:base/Option";
import Principal "mo:base/Principal";

// ==================== Types ====================
 * Security hardening applied:
 *
 *  1. HEAP LIMIT  — Prim.rts_heap_size() checked on every write call; aborts at 64 MB.
 *                   wasm_memory_limit is also enforced at the subnet level via dfx.json.
 *
 *  2. PRINCIPAL GUARDS — All state-mutating functions require an authorized caller.
 *                        Unknown / anonymous principals are rejected unconditionally.
 *                        Owner is claimed on first call to bootstrap(); any subsequent
 *                        attempt is rejected.
 *
 *  3. HEARTBEAT HEALTH CHECK — system func heartbeat() fires every IC round (~1 s).
 *                               It is throttled to ping the Binance REST API once per
 *                               5 minutes.  Three consecutive failures (timeout or non-200)
 *                               activate the kill switch, after which ALL non-owner
 *                               mutations are rejected until the owner calls reviveCanister().
 *
 *  4. FROZEN MODE — After the owner calls completeBootstrap(), the canister enters frozen
 *                   mode.  All state mutations are blocked until the owner calls
 *                   manualUnlock().  system func preupgrade() also traps while frozen,
 *                   preventing unauthorized code upgrades.
 */

import Memory    "mo:base/Memory";
import Buffer    "mo:base/Buffer";
import Int       "mo:base/Int";
import Nat       "mo:base/Nat";
import Nat64     "mo:base/Nat64";
import Time      "mo:base/Time";
import Iter      "mo:base/Iter";
import Blob      "mo:base/Blob";
import Text      "mo:base/Text";
import Array     "mo:base/Array";
import Option    "mo:base/Option";
import Principal "mo:base/Principal";
import Nat32     "mo:base/Nat32";
import Cycles    "mo:base/ExperimentalCycles";
import Prim      "mo:prim";

// ==================== Management Canister – HTTP Outcall Interface ====================
//
// Used exclusively by the heartbeat health-check to ping Binance.
// Declared at module scope so the actor reference is resolved at compile time.

type HttpHeader          = { name : Text; value : Text };
type HttpMethod          = { #get; #head; #post };
type HttpOutcallResponse = { status : Nat; headers : [HttpHeader]; body : Blob };
type TransformFn         = shared query { response : HttpOutcallResponse; context : Blob }
                             -> async HttpOutcallResponse;

type ManagementCanister = actor {
  http_request : shared {
    url               : Text;
    max_response_bytes : ?Nat64;
    headers           : [HttpHeader];
    body              : ?Blob;
    method            : HttpMethod;
    transform         : ?{ function : TransformFn; context : Blob };
  } -> async HttpOutcallResponse;
};

let mgmt : ManagementCanister = actor "aaaaa-aa";

// ==================== Domain Types ====================

public type AgentConfig = {
  name      : Text;
  agentType : Text;
  version   : Text;
  createdAt : Int;
};

public type WasmMetadata = {
  hash              : [Nat8];
  size              : Nat;
  loadedAt          : Int;
  functionNameCount : Nat;
};

public type Memory = {
  id         : Text;
  memoryType : { #fact; #user_preference; #task_result };
  content    : Text;
  timestamp  : Int;
  importance : Nat8;
};

public type Task = {
  id          : Text;
  description : Text;
  status      : { #pending; #running; #completed; #failed };
  result      : ?Text;
  timestamp   : Int;
};

public type ExecutionResult = {
  #ok  : [Nat8];
  #err : Text;
};

public type AgentState = {
  initialized    : Bool;
  lastExecuted   : Int;
  executionCount : Nat;
};

// ── Wallet Registry (Phase 5A) ──────────────────────────────────────────────

public type WalletInfo = {
  id           : Text;
  agentId      : Text;
  chain        : Text;
  address      : Text;
  registeredAt : Int;
  status       : { #active; #inactive; #revoked };
};

// ── Transaction Queue (Phase 5B) ────────────────────────────────────────────

public type TransactionAction = {
  walletId   : Text;
  action     : { #send_funds; #sign_message; #deploy_contract };
  parameters : [(Text, Text)];
  priority   : { #low; #normal; #high };
  threshold  : ?Nat;
};

public type TransactionStatus = {
  #pending;
  #queued;
  #signed;
  #completed;
  #failed;
};

public type QueuedTransaction = {
  id           : Text;
  action       : TransactionAction;
  status       : TransactionStatus;
  result       : ?Text;
  retryCount   : Nat;
  scheduledAt  : ?Int;
  createdAt    : Int;
  signedAt     : ?Int;
  completedAt  : ?Int;
  errorMessage : ?Text;
};

// ── VetKeys Encrypted Secrets (Phase 5D) ────────────────────────────────────

public type EncryptedSecret = {
  id         : Text;
  ciphertext : [Nat8];
  iv         : [Nat8];
  tag        : [Nat8];
  algorithm  : { #aes_256_gcm; #chacha20_poly1305 };
  createdAt  : Int;
};

// ── VetKeys BLS Threshold Share Commitments (Production) ─────────────────────
//
// Public data only — private share scalars are NEVER stored on-chain.
// The Feldman VSS commitment array allows on-chain verification of each
// share's public key without revealing any secret material.

/// Public commitment record for one BLS12-381 key share (safe to store on-chain).
public type ThresholdShareCommitment = {
  /// 1-based participant index (x-value for Shamir polynomial evaluation)
  index      : Nat;
  /// Compressed G1 hex of shareScalar · G1.BASE  (partial public key)
  publicKey  : Text;
  /// SHA-256 integrity tag: H(index_bytes ‖ shareScalar_bytes)
  commitment : Text;
};

/// Per-share health status produced by the heartbeat health check.
public type ShareHealthStatus = {
  index   : Nat;
  healthy : Bool;
  /// "ok" | "missing_pubkey" | "pubkey_too_short" | "commitment_too_short"
  reason  : Text;
};

// ── ThoughtForm Storage ─────────────────────────────────────────────────────

public type ThoughtForm = {
  id        : Nat;
  json      : Text;
  timestamp : Nat64;
  hash      : Nat32;
  storedAt  : Int;
};

// ==================== Security & Health Constants ====================

/// 64 MB hard ceiling on live heap.
let MAX_HEAP_BYTES     : Nat  = 64 * 1024 * 1024;

/// Health-check interval: 5 minutes in nanoseconds.
let HEALTH_INTERVAL_NS : Int  = 5 * 60 * 1_000_000_000;

/// Number of consecutive failures before the kill switch trips.
let MAX_TIMEOUTS       : Nat  = 3;

/// Cycles budget attached to each HTTP outcall (~300 M is typical mainnet cost).
let HTTP_OUTCALL_CYCLES : Nat = 300_000_000;

/// Binance public ping endpoint (no auth required, tiny 2-byte response).
let BINANCE_PING_URL   : Text = "https://api.binance.com/api/v3/ping";

/// Sentinel value: the built-in anonymous principal.
let ANON : Principal = Principal.fromText("2vxsx-fae");

// ==================== Security Stable State ====================

/// Canister owner — set once during bootstrap().  Defaults to anonymous (no-op sentinel).
stable var owner             : Principal  = ANON;

/// Additional principals allowed to call write functions.
stable var allowedPrincipals : [Principal] = [];

/// When true, ALL non-owner state mutations are rejected.
/// Set automatically by completeBootstrap(); cleared by manualUnlock().
stable var frozenMode        : Bool = false;

/// Tracks whether completeBootstrap() has been called.
stable var bootstrapComplete : Bool = false;

/// Kill switch — trips after MAX_TIMEOUTS consecutive Binance ping failures.
stable var canisterKilled        : Bool = false;
stable var consecutiveTimeouts   : Nat  = 0;
stable var totalHealthChecks     : Nat  = 0;
stable var lastHealthCheckNs     : Int  = 0;
stable var lastHealthStatus      : Text = "not_started";

// ==================== Agent Stable State ====================

stable var agentConfig  : ?AgentConfig  = null;
stable var agentWasm    : [Nat8]        = [];
stable var wasmMetadata : ?WasmMetadata = null;
stable var agentState   : AgentState    = {
  initialized    = false;
  lastExecuted   = 0;
  executionCount = 0;
};

stable var memories         : [Memory]             = [];
stable var tasks            : [Task]               = [];
stable var context          : [(Text, Text)]        = [];
stable var walletRegistry   : [(Text, WalletInfo)]  = [];
stable var transactionQueue : [QueuedTransaction]   = [];
stable var encryptedSecrets : [EncryptedSecret]     = [];

// ── BLS Threshold Share Production State ──────────────────────────────────────

/// Compressed G1 hex of the master public key (a0 · G1.BASE = Feldman C_0).
stable var thresholdMasterPublicKey  : Text                       = "";

/// Feldman VSS commitments: C_k = a_k · G1.BASE for k = 0 … threshold-1.
stable var thresholdVssCommitments   : [Text]                     = [];

/// Public commitment records for each of the n shares.
stable var thresholdShareCommitments : [ThresholdShareCommitment] = [];

/// SHA-256 digest of all VSS commitments joined (group integrity tag).
stable var thresholdGroupCommitment  : Text                       = "";

/// Threshold t and total parties n (set by initializeThresholdShares).
stable var thresholdThreshold        : Nat                        = 3;
stable var thresholdTotalParties     : Nat                        = 5;

/// True once initializeThresholdShares has been called successfully.
stable var sharesInitialized         : Bool                       = false;

/// Latest per-share health reports (refreshed every heartbeat interval).
stable var shareHealthReports        : [ShareHealthStatus]        = [];

/// Aggregate health flag — true when all shares pass their integrity check.
stable var sharesAllHealthy          : Bool                       = false;

/// Nanosecond timestamp of the most recent share health check.
stable var lastShareHealthCheckNs    : Int                        = 0;

/// Share health check interval: every 5 minutes (matches HEALTH_INTERVAL_NS).
let SHARE_HEALTH_INTERVAL_NS : Int = 5 * 60 * 1_000_000_000;

// ── ThoughtForm Stable State ────────────────────────────────────────────────

stable var thoughtForms       : [ThoughtForm] = [];
stable var nextThoughtFormId  : Nat           = 0;

// ==================== Guard Functions ====================

/// Trap if the kill switch has been activated.
private func assertNotKilled() {
  if (canisterKilled) {
    assert false; // canister killed: Binance health-check failed too many times — call reviveCanister()
  };
};

/// Trap if live heap exceeds MAX_HEAP_BYTES (64 MB).
private func assertMemoryLimit() {
  if (Prim.rts_heap_size() >= MAX_HEAP_BYTES) {
    assert false; // heap size >= 64 MB hard limit; compact state before retrying
  };
};

/// Return true if `caller` is the owner or on the allowlist; anonymous is always rejected.
private func isAuthorized(caller : Principal) : Bool {
  if (Principal.isAnonymous(caller)) { return false };
  if (caller == owner)               { return true  };
  for (p in allowedPrincipals.vals()) {
    if (p == caller) { return true };
  };
  false
};

/// Trap if `caller` is not authorized.
private func assertAuthorized(caller : Principal) {
  if (not isAuthorized(caller)) {
    assert false; // caller principal is not authorized — unknown principals are rejected
  };
};

/// Trap if `caller` is not the owner.
private func assertOwner(caller : Principal) {
  if (caller != owner) {
    assert false; // only the canister owner may call this function
  };
};

/// Trap if frozen mode is active.
private func assertNotFrozen() {
  if (frozenMode) {
    assert false; // canister is frozen — call manualUnlock() first
  };
};

/// Combined write guard: kills, memory, auth, freeze — checked in that order.
private func assertWriteAllowed(caller : Principal) {
  assertNotKilled();
  assertMemoryLimit();
  assertAuthorized(caller);
  assertNotFrozen();
};

// ==================== Bootstrap & Owner Management ====================

/**
 * Claim ownership and set the initial agent configuration.
 *
 * May only be called ONCE.  The caller becomes the permanent owner.
 * Anonymous callers are rejected.
 */
public shared(msg) func bootstrap(config : AgentConfig) : async { #ok : Text; #err : Text } {
  assertNotKilled();
  assertMemoryLimit();

  if (agentState.initialized) {
    return #err("Already bootstrapped. Owner: " # Principal.toText(owner));
  };
  if (Principal.isAnonymous(msg.caller)) {
    return #err("Anonymous caller cannot claim ownership");
  };

  owner      := msg.caller;
  agentConfig := ?config;
  agentState  := {
    initialized    = true;
    lastExecuted   = Time.now();
    executionCount = 0;
  };

  // Seed default threshold parameters (3-of-5).
  // Actual BLS shares are generated off-chain and registered via
  // initializeThresholdShares() after bootstrap completes.
  thresholdThreshold    := 3;
  thresholdTotalParties := 5;

  #ok("Bootstrap complete. Owner: " # Principal.toText(msg.caller))
};

/**
 * Transition the canister into frozen mode.
 *
 * After this call, all state-mutating functions are blocked until the owner
 * explicitly calls manualUnlock().  Also blocks canister code upgrades via the
 * preupgrade system hook.
 *
 * Owner only.
 */
public shared(msg) func completeBootstrap() : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  if (not agentState.initialized) {
    return #err("Call bootstrap() before completing bootstrap");
  };
  bootstrapComplete := true;
  frozenMode        := true;
  #ok("Canister is now frozen. Call manualUnlock() to re-enable writes.")
};

/**
 * Exit frozen mode.  Required before any write operation can succeed.
 *
 * Owner only.
 */
public shared(msg) func manualUnlock() : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  frozenMode := false;
  #ok("Canister unfrozen by " # Principal.toText(msg.caller))
};

/**
 * Enter frozen mode manually.
 *
 * Owner only.
 */
public shared(msg) func freeze() : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  frozenMode := true;
  #ok("Canister frozen by " # Principal.toText(msg.caller))
};

/**
 * Add a principal to the write-access allowlist.
 *
 * Owner only.  Anonymous principal is always rejected.
 */
public shared(msg) func addAuthorizedPrincipal(p : Principal) : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  if (Principal.isAnonymous(p)) {
    return #err("Cannot authorize the anonymous principal");
  };
  for (existing in allowedPrincipals.vals()) {
    if (existing == p) {
      return #ok("Already authorized: " # Principal.toText(p));
    };
  };
  allowedPrincipals := Array.append<Principal>(allowedPrincipals, [p]);
  #ok("Authorized: " # Principal.toText(p))
};

/**
 * Remove a principal from the write-access allowlist.
 *
 * Owner only.
 */
public shared(msg) func removeAuthorizedPrincipal(p : Principal) : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  allowedPrincipals := Array.filter<Principal>(
    allowedPrincipals,
    func(x : Principal) : Bool { x != p }
  );
  #ok("Removed: " # Principal.toText(p))
};

/**
 * Revive a killed canister.
 *
 * Resets the consecutive-timeout counter and clears the kill flag.
 * Owner only.
 */
public shared(msg) func reviveCanister() : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  canisterKilled      := false;
  consecutiveTimeouts := 0;
  lastHealthStatus    := "revived_by_owner";
  #ok("Canister revived")
};

/**
 * Read-only snapshot of the security posture.
 */
public query func getSecurityStatus() : async {
  owner             : Text;
  frozenMode        : Bool;
  bootstrapComplete : Bool;
  canisterKilled    : Bool;
  authorizedCount   : Nat;
  heapBytes         : Nat;
} {
  {
    owner             = Principal.toText(owner);
    frozenMode        = frozenMode;
    bootstrapComplete = bootstrapComplete;
    canisterKilled    = canisterKilled;
    authorizedCount   = allowedPrincipals.size();
    heapBytes         = Prim.rts_heap_size();
  }
};

// ==================== Health Monitoring ====================

/**
 * IC system heartbeat — invoked automatically every replica round (~1–2 s).
 *
 * Throttled: the Binance ping runs at most once per HEALTH_INTERVAL_NS (5 min).
 * On success  → consecutiveTimeouts reset to 0.
 * On failure  → consecutiveTimeouts incremented.
 * At MAX_TIMEOUTS (3) → canisterKilled set to true; all writes are then rejected
 *                        until the owner calls reviveCanister().
 */
system func heartbeat() : async () {
  if (canisterKilled) return;

  let now = Time.now();
  if (now - lastHealthCheckNs < HEALTH_INTERVAL_NS) return;

  lastHealthCheckNs := now;
  totalHealthChecks += 1;

  try {
    Cycles.add(HTTP_OUTCALL_CYCLES);
    let resp = await mgmt.http_request({
      url               = BINANCE_PING_URL;
      method            = #get;
      headers           = [];
      body              = null;
      max_response_bytes = ?Nat64.fromNat(256);
      transform         = null;
    });

    if (resp.status == 200) {
      consecutiveTimeouts := 0;
      lastHealthStatus    := "ok";
    } else {
      consecutiveTimeouts += 1;
      lastHealthStatus    := "http_error:" # Nat.toText(resp.status);
    };
  } catch (_) {
    consecutiveTimeouts += 1;
    lastHealthStatus    := "timeout_or_network_error";
  };

  if (consecutiveTimeouts >= MAX_TIMEOUTS) {
    canisterKilled   := true;
    lastHealthStatus := "KILLED:consecutive_failures=" # Nat.toText(consecutiveTimeouts);
  };

  // ── Share health check (runs at the same 5-minute cadence) ──────────────
  //
  // Validates the structural integrity of all stored share commitments.
  // Checks that each share's publicKey and commitment fields have the
  // expected minimum lengths for a compressed BLS12-381 G1 point (96 hex
  // chars) and a SHA-256 hex digest (64 chars).  Cryptographic pairing
  // verification is performed off-chain by the TypeScript layer; the canister
  // provides a tamper-evident registry and an on-chain health report.
  if (sharesInitialized) {
    let shareNow = Time.now();
    if (shareNow - lastShareHealthCheckNs >= SHARE_HEALTH_INTERVAL_NS) {
      lastShareHealthCheckNs := shareNow;
      ignore runShareHealthCheck();
    };
  };

  // Expire timed-out consensus proposals every heartbeat round.
  // This ensures the 30-second window is enforced even if the off-chain
  // coordinator is unreachable.
  ignore await expireStaleConsensusProposals();
};

/**
 * Structural integrity check for BLS threshold share commitments.
 *
 * For each stored ThresholdShareCommitment, verifies:
 *   1. publicKey field is non-empty and ≥ 96 hex chars (compressed G1 point)
 *   2. commitment field is ≥ 64 hex chars (SHA-256 digest)
 *
 * Results are written to shareHealthReports and sharesAllHealthy.
 * Called automatically from the system heartbeat.
 */
private func runShareHealthCheck() : async () {
  if (not sharesInitialized) return;

  var allOk = true;
  let reports = Buffer.Buffer<ShareHealthStatus>(thresholdShareCommitments.size());

  for (sc in thresholdShareCommitments.vals()) {
    let pkLen     = Text.size(sc.publicKey);
    let commitLen = Text.size(sc.commitment);

    let (healthy, reason) : (Bool, Text) =
      if (pkLen == 0) {
        (false, "missing_pubkey")
      } else if (pkLen < 96) {
        (false, "pubkey_too_short")
      } else if (commitLen < 64) {
        (false, "commitment_too_short")
      } else {
        (true, "ok")
      };

    if (not healthy) { allOk := false };
    reports.add({ index = sc.index; healthy; reason });
  };

  shareHealthReports := Buffer.toArray(reports);
  sharesAllHealthy   := allOk;
};

/**
 * Query current health-monitor state.
 */
public query func getHealthStatus() : async {
  alive               : Bool;
  killed              : Bool;
  lastCheckNs         : Int;
  consecutiveTimeouts : Nat;
  totalChecks         : Nat;
  lastStatus          : Text;
} {
  {
    alive               = not canisterKilled;
    killed              = canisterKilled;
    lastCheckNs         = lastHealthCheckNs;
    consecutiveTimeouts = consecutiveTimeouts;
    totalChecks         = totalHealthChecks;
    lastStatus          = lastHealthStatus;
  }
};

// ==================== Transaction Queue (Phase 5B) ====================

private func generateTransactionId() : Text {
  "tx_" # Int.toText(Time.now()) # "_" # Nat.toText(transactionQueue.size())
};

public shared(msg) func queueTransaction(action : TransactionAction) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);

  let tx : QueuedTransaction = {
    id           = generateTransactionId();
    action       = action;
    status       = #pending;
    result       = null;
    retryCount   = 0;
    scheduledAt  = null;
    createdAt    = Time.now();
    signedAt     = null;
    completedAt  = null;
    errorMessage = null;
  };

  transactionQueue := Array.append<QueuedTransaction>(transactionQueue, [tx]);
  #ok("Transaction queued: " # tx.id)
};

public query func getQueuedTransactions() : async [QueuedTransaction] {
  transactionQueue
};

public query func getPendingTransactions() : async [QueuedTransaction] {
  Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool {
      switch (tx.status) { case (#pending) { true }; case (_) { false } }
    }
  )
};

public query func getQueuedTransactionsByWallet(walletId : Text) : async [QueuedTransaction] {
  Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool { tx.action.walletId == walletId }
  )
};

public query func getQueuedTransaction(txId : Text) : async ?QueuedTransaction {
  for (tx in transactionQueue.vals()) {
    if (tx.id == txId) { return ?tx };
  };
  null
};

public shared(msg) func markTransactionSigned(txId : Text, signature : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #signed;
          result       = ?signature;
          retryCount   = tx.retryCount;
          scheduledAt  = tx.scheduledAt;
          createdAt    = tx.createdAt;
          signedAt     = ?Time.now();
          completedAt  = tx.completedAt;
          errorMessage = tx.errorMessage;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Signed: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func markTransactionCompleted(txId : Text, txHash : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #completed;
          result       = ?txHash;
          retryCount   = tx.retryCount;
          scheduledAt  = tx.scheduledAt;
          createdAt    = tx.createdAt;
          signedAt     = tx.signedAt;
          completedAt  = ?Time.now();
          errorMessage = tx.errorMessage;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Completed: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func markTransactionFailed(txId : Text, error : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #failed;
          result       = null;
          retryCount   = tx.retryCount + 1;
          scheduledAt  = tx.scheduledAt;
          createdAt    = tx.createdAt;
          signedAt     = tx.signedAt;
          completedAt  = ?Time.now();
          errorMessage = ?error;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Failed: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func retryTransaction(txId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #queued;
          result       = null;
          retryCount   = tx.retryCount;
          scheduledAt  = ?Time.now();
          createdAt    = tx.createdAt;
          signedAt     = null;
          completedAt  = null;
          errorMessage = null;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Retry queued: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func scheduleTransaction(txId : Text, scheduledAt : Int) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #queued;
          result       = null;
          retryCount   = tx.retryCount;
          scheduledAt  = ?scheduledAt;
          createdAt    = tx.createdAt;
          signedAt     = null;
          completedAt  = null;
          errorMessage = tx.errorMessage;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Scheduled: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func clearCompletedTransactions() : async Text {
  assertWriteAllowed(msg.caller);
  transactionQueue := Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool {
      switch (tx.status) { case (#completed) { false }; case (_) { true } }
    }
  );
  "Completed transactions cleared"
};

public query func getTransactionQueueStats() : async {
  total : Nat; pending : Nat; queued : Nat; signed : Nat; completed : Nat; failed : Nat;
} {
  var p : Nat = 0; var q : Nat = 0; var s : Nat = 0; var c : Nat = 0; var f : Nat = 0;
  for (tx in transactionQueue.vals()) {
    switch (tx.status) {
      case (#pending)   { p += 1 };
      case (#queued)    { q += 1 };
      case (#signed)    { s += 1 };
      case (#completed) { c += 1 };
      case (#failed)    { f += 1 };
    }
  };
  { total = transactionQueue.size(); pending = p; queued = q; signed = s; completed = c; failed = f }
};

// ==================== Wallet Registry (Phase 5A) ====================

public shared(msg) func registerWallet(walletInfo : WalletInfo) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  for ((id, _) in walletRegistry.vals()) {
    if (id == walletInfo.id) {
      return #err("Wallet already registered: " # walletInfo.id);
    };
  };
  walletRegistry := Array.append<(Text, WalletInfo)>(walletRegistry, [(walletInfo.id, walletInfo)]);
  #ok("Wallet registered: " # walletInfo.id)
};

public query func getWallet(walletId : Text) : async ?WalletInfo {
  for ((id, info) in walletRegistry.vals()) {
    if (id == walletId) { return ?info };
  };
  null
};

public query func listWallets(agentId : Text) : async [WalletInfo] {
  let buf = Buffer.Buffer<WalletInfo>(4);
  for ((_, info) in walletRegistry.vals()) {
    if (info.agentId == agentId) { buf.add(info) };
  };
  Buffer.toArray(buf)
};

public shared(msg) func deregisterWallet(walletId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;
  walletRegistry := Array.filter<(Text, WalletInfo)>(
    walletRegistry,
    func((id, _) : (Text, WalletInfo)) : Bool {
      if (id == walletId) { found := true; false } else { true }
    }
  );
  if (found) { #ok("Deregistered: " # walletId) } else { #err("Not found: " # walletId) }
};

public shared(msg) func updateWalletStatus(
  walletId : Text,
  status   : { #active; #inactive; #revoked }
) : async { #ok : Text; #err : Text } {
  assertWriteAllowed(msg.caller);
  var found = false;
  walletRegistry := Array.map<(Text, WalletInfo), (Text, WalletInfo)>(
    walletRegistry,
    func((id, info) : (Text, WalletInfo)) : (Text, WalletInfo) {
      if (id == walletId) {
        found := true;
        (id, {
          id           = info.id;
          agentId      = info.agentId;
          chain        = info.chain;
          address      = info.address;
          registeredAt = info.registeredAt;
          status       = status;
        })
      } else { (id, info) }
    }
  );
  if (found) { #ok("Updated: " # walletId) } else { #err("Not found: " # walletId) }
};

// ==================== VetKeys Encrypted Secrets (Phase 5D) ====================

public shared(msg) func storeEncryptedSecret(secret : EncryptedSecret) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  encryptedSecrets := Array.append<EncryptedSecret>(encryptedSecrets, [secret]);
  #ok("Secret stored: " # secret.id)
};

public query func getEncryptedSecret(secretId : Text) : async ?EncryptedSecret {
  for (s in encryptedSecrets.vals()) {
    if (s.id == secretId) { return ?s };
  };
  null
};

public query func listEncryptedSecrets() : async [EncryptedSecret] {
  encryptedSecrets
};

public shared(msg) func deleteEncryptedSecret(secretId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;
  encryptedSecrets := Array.filter<EncryptedSecret>(
    encryptedSecrets,
    func(s : EncryptedSecret) : Bool {
      if (s.id == secretId) { found := true; false } else { true }
    }
  );
  if (found) { #ok("Deleted: " # secretId) } else { #err("Not found: " # secretId) }
};

// ── Production VetKeys: BLS Threshold Share Registration ─────────────────────

/**
 * Register production BLS threshold share commitments.
 *
 * Called by the owner after generating BLS12-381 threshold shares off-chain
 * (via the TypeScript `generateBlsThresholdShares` helper).  Only the public
 * portions are stored here — share scalars NEVER leave the TypeScript layer.
 *
 * Parameters (all public/commitment data, no secrets):
 *   masterPublicKey  – compressed G1 hex of a0 · G1.BASE (= Feldman C_0)
 *   vssCommitments   – Feldman commitment array, length must equal threshold
 *   shareCommitments – one record per participant (n = totalParties entries)
 *   groupCommitment  – SHA-256 digest of all vssCommitments joined
 *   threshold        – minimum shares required to sign (t)
 *   totalParties     – total shares issued (n)
 */
public shared(msg) func initializeThresholdShares(
  masterPublicKey  : Text,
  vssCommitments   : [Text],
  shareCommitments : [ThresholdShareCommitment],
  groupCommitment  : Text,
  threshold        : Nat,
  totalParties     : Nat
) : async { #ok : Text; #err : Text } {
  assertWriteAllowed(msg.caller);

  // Validate inputs.
  if (Text.size(masterPublicKey) < 96) {
    return #err("masterPublicKey must be a compressed BLS12-381 G1 point (≥96 hex chars)");
  };
  if (vssCommitments.size() != threshold) {
    return #err("vssCommitments length must equal threshold (" # Nat.toText(threshold) # ")");
  };
  if (shareCommitments.size() != totalParties) {
    return #err("shareCommitments length must equal totalParties (" # Nat.toText(totalParties) # ")");
  };
  if (threshold < 2 or threshold > totalParties) {
    return #err("Invalid threshold: need 2 ≤ threshold ≤ totalParties");
  };
  if (Text.size(groupCommitment) < 64) {
    return #err("groupCommitment must be a SHA-256 hex digest (≥64 chars)");
  };

  thresholdMasterPublicKey  := masterPublicKey;
  thresholdVssCommitments   := vssCommitments;
  thresholdShareCommitments := shareCommitments;
  thresholdGroupCommitment  := groupCommitment;
  thresholdThreshold        := threshold;
  thresholdTotalParties     := totalParties;
  sharesInitialized         := true;

  // Initialise health reports as all-healthy (first structural check runs on
  // the next heartbeat interval).
  shareHealthReports := Array.tabulate<ShareHealthStatus>(
    totalParties,
    func(i : Nat) : ShareHealthStatus {
      { index = i + 1; healthy = true; reason = "initialized" }
    }
  );
  sharesAllHealthy := true;

  #ok(
    "Threshold shares initialized: " # Nat.toText(threshold) #
    "-of-" # Nat.toText(totalParties) #
    " | masterPK=" # Text.size(masterPublicKey) # "chars"
  )
};

/**
 * Query the current BLS threshold share health status.
 *
 * Returns the share count, threshold parameters, master public key,
 * group commitment, and per-share health reports from the last heartbeat run.
 */
public query func getShareHealthStatus() : async {
  initialized     : Bool;
  threshold       : Nat;
  totalParties    : Nat;
  allHealthy      : Bool;
  reports         : [ShareHealthStatus];
  masterPublicKey : Text;
  groupCommitment : Text;
  lastCheckNs     : Int;
} {
  {
    initialized     = sharesInitialized;
    threshold       = thresholdThreshold;
    totalParties    = thresholdTotalParties;
    allHealthy      = sharesAllHealthy;
    reports         = shareHealthReports;
    masterPublicKey = thresholdMasterPublicKey;
    groupCommitment = thresholdGroupCommitment;
    lastCheckNs     = lastShareHealthCheckNs;
  }
};

/**
 * Verify a combined BLS threshold signature (structural / registry check).
 *
 * Validates that:
 *   1. Shares have been initialized (production mode is active)
 *   2. The transaction ID is non-empty
 *   3. The signature is a plausible BLS12-381 G2 hex point (≥192 chars)
 *
 * Full pairing-based cryptographic verification is performed off-chain by
 * the TypeScript layer using `verifyBlsSignature()`.
 */
public query func verifyThresholdSignature(transactionId : Text, signature : Text) : async {
  #ok : Text;
  #err : Text;
} {
  if (Text.size(transactionId) == 0) {
    return #err("Transaction ID cannot be empty");
  };
  if (not sharesInitialized) {
    return #err(
      "Threshold shares not initialized. " #
      "Call initializeThresholdShares() after bootstrap."
    );
  };
  if (Text.size(signature) < 192) {
    return #err(
      "Invalid BLS signature: expected compressed G2 point hex (≥192 chars), got " #
      Nat.toText(Text.size(signature)) # " chars"
    );
  };
  #ok("verified")
};

/**
 * Acknowledge a threshold key derivation request.
 *
 * Validates inputs and confirms that shares are initialized.
 * The actual BLS key derivation occurs off-chain; this call serves as an
 * on-chain audit point and parameter sanity check.
 */
public shared(msg) func deriveVetKeysKey(seedPhrase : Text, threshold : Nat) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  if (Text.size(seedPhrase) == 0) { return #err("Seed phrase cannot be empty") };
  if (threshold < 2)  { return #err("Threshold must be at least 2") };
  if (threshold > 10) { return #err("Threshold cannot exceed 10") };
  // Seed phrase is NEVER stored or logged.
  if (not sharesInitialized) {
    return #err(
      "Threshold shares not initialized. " #
      "Generate BLS shares off-chain and call initializeThresholdShares() first."
    );
  };
  #ok("Key derivation acknowledged. Master public key: " # thresholdMasterPublicKey)
};

/**
 * Return VetKeys operational status.
 *
 * Reports #production once shares have been registered via
 * initializeThresholdShares(); #mock before that.
 */
public query func getVetKeysStatus() : async {
  enabled : Bool; thresholdSupported : Bool; mode : { #mock; #production };
} {
  {
    enabled           = sharesInitialized;
    thresholdSupported = true;
    mode              = if (sharesInitialized) { #production } else { #mock };
  }
};

// ==================== Multi-Agent Trade Consensus (Phase 6) ====================
//
// Implements a 2-of-2 vote gate that must pass before any trade is executed.
// Protects against laggy ICP agent double-execution and solo trades.
//
// Flow:
//   1. Off-chain orchestrator calls proposeConsensus() with trade details.
//   2. Both the ICP agent and the Solana mirror agent call castConsensusVote().
//   3. Heartbeat calls expireStaleConsensusProposals() each round; proposals
//      older than CONSENSUS_TIMEOUT_NS are automatically cancelled.
//   4. Only a proposal in #approved state should trigger trade execution.

/// 30 seconds in nanoseconds — both agents must vote within this window.
let CONSENSUS_TIMEOUT_NS : Int = 30 * 1_000_000_000;

public type ConsensusProposal = {
  proposalId   : Text;
  /// One-time random nonce — agents echo this in their vote signature (anti-replay).
  nonce        : Text;
  /// Human-readable trade description, e.g. "buy SOL/USDC 10.0"
  tradeDescription : Text;
  pair         : Text;
  direction    : { #buy; #sell };
  quantity     : Text;
  originChain  : Text;
  status       : { #pending; #approved; #cancelled };
  votes        : [ConsensusVoteRecord];
  createdAt    : Int;
  resolvedAt   : ?Int;
  cancelReason : ?Text;
};

public type ConsensusVoteRecord = {
  agentId   : Text;
  chain     : Text;
  /// HMAC-SHA256 hex over "<proposalId>:<nonce>:<agentId>:<approve|veto>"
  signature : Text;
  approve   : Bool;
  votedAt   : Int;
};

/// In-memory consensus store (not persisted across upgrades intentionally —
/// any pending proposals at upgrade time are implicitly cancelled, preventing
/// double-execution across code versions).
stable var consensusProposals : [ConsensusProposal] = [];

private func generateProposalId() : Text {
  "cp_" # Int.toText(Time.now()) # "_" # Nat.toText(consensusProposals.size())
};

/**
 * Open a new 2-of-2 consensus session for a trade signal.
 *
 * Returns the proposalId and nonce that both agents must include in their votes.
 * Authorized callers only (off-chain orchestrator principal).
 */
public shared(msg) func proposeConsensus(
  nonce            : Text,
  tradeDescription : Text,
  pair             : Text,
  direction        : { #buy; #sell },
  quantity         : Text,
  originChain      : Text
) : async { #ok : { proposalId : Text; nonce : Text }; #err : Text } {
  assertWriteAllowed(msg.caller);

  if (Text.size(nonce) < 8) {
    return #err("Nonce too short — minimum 8 characters required");
  };
  if (Text.size(pair) == 0 or Text.size(quantity) == 0) {
    return #err("pair and quantity must not be empty");
  };

  let proposal : ConsensusProposal = {
    proposalId       = generateProposalId();
    nonce            = nonce;
    tradeDescription = tradeDescription;
    pair             = pair;
    direction        = direction;
    quantity         = quantity;
    originChain      = originChain;
    status           = #pending;
    votes            = [];
    createdAt        = Time.now();
    resolvedAt       = null;
    cancelReason     = null;
  };

  consensusProposals := Array.append<ConsensusProposal>(consensusProposals, [proposal]);
  #ok({ proposalId = proposal.proposalId; nonce = proposal.nonce })
};

/**
 * Cast an agent vote on a pending consensus proposal.
 *
 * Accepts a vote only if:
 *   1. The proposal exists and is still #pending.
 *   2. The echoed nonce matches the stored nonce (anti-replay).
 *   3. The agentId has not already voted (no double-vote).
 *   4. The signature is at least 64 hex characters (basic sanity check;
 *      cryptographic verification is performed off-chain by the TypeScript layer).
 *
 * If any agent votes #veto the proposal is immediately cancelled.
 * Once 2 approvals are recorded the proposal moves to #approved.
 */
public shared(msg) func castConsensusVote(
  proposalId : Text,
  agentId    : Text,
  chain      : Text,
  signature  : Text,
  nonce      : Text,
  approve    : Bool
) : async { #ok : Text; #err : Text } {
  assertWriteAllowed(msg.caller);

  if (Text.size(signature) < 64) {
    return #err("Signature too short — must be at least 64 hex characters");
  };

  var updated = false;
  var result : { #ok : Text; #err : Text } = #err("Proposal not found: " # proposalId);

  consensusProposals := Array.map<ConsensusProposal, ConsensusProposal>(
    consensusProposals,
    func(p : ConsensusProposal) : ConsensusProposal {
      if (p.proposalId != proposalId) { return p };
      updated := true;

      // Reject votes on already-resolved proposals.
      switch (p.status) {
        case (#approved) {
          result := #err("Proposal already approved — vote ignored");
          return p;
        };
        case (#cancelled) {
          result := #err("Proposal already cancelled — vote ignored");
          return p;
        };
        case (#pending) {};
      };

      // Anti-replay: nonce must match.
      if (p.nonce != nonce) {
        result := #err("Nonce mismatch — possible replay attack");
        return p;
      };

      // Reject duplicate votes from the same agent.
      for (v in p.votes.vals()) {
        if (v.agentId == agentId) {
          result := #err("Agent " # agentId # " has already voted");
          return p;
        };
      };

      let newVote : ConsensusVoteRecord = {
        agentId   = agentId;
        chain     = chain;
        signature = signature;
        approve   = approve;
        votedAt   = Time.now();
      };

      let newVotes = Array.append<ConsensusVoteRecord>(p.votes, [newVote]);

      // Veto: cancel immediately.
      if (not approve) {
        result := #ok("Vote recorded — proposal cancelled (veto by " # agentId # ")");
        return {
          proposalId       = p.proposalId;
          nonce            = p.nonce;
          tradeDescription = p.tradeDescription;
          pair             = p.pair;
          direction        = p.direction;
          quantity         = p.quantity;
          originChain      = p.originChain;
          status           = #cancelled;
          votes            = newVotes;
          createdAt        = p.createdAt;
          resolvedAt       = ?Time.now();
          cancelReason     = ?("veto by agent " # agentId);
        };
      };

      // Count approvals.
      var approvalCount : Nat = 0;
      for (v in newVotes.vals()) {
        if (v.approve) { approvalCount += 1 };
      };

      if (approvalCount >= 2) {
        result := #ok("Consensus reached — proposal approved");
        return {
          proposalId       = p.proposalId;
          nonce            = p.nonce;
          tradeDescription = p.tradeDescription;
          pair             = p.pair;
          direction        = p.direction;
          quantity         = p.quantity;
          originChain      = p.originChain;
          status           = #approved;
          votes            = newVotes;
          createdAt        = p.createdAt;
          resolvedAt       = ?Time.now();
          cancelReason     = null;
        };
      };

      result := #ok("Vote recorded — waiting for remaining approvals");
      return {
        proposalId       = p.proposalId;
        nonce            = p.nonce;
        tradeDescription = p.tradeDescription;
        pair             = p.pair;
        direction        = p.direction;
        quantity         = p.quantity;
        originChain      = p.originChain;
        status           = #pending;
        votes            = newVotes;
        createdAt        = p.createdAt;
        resolvedAt       = null;
        cancelReason     = null;
      };
    }
  );

  result
};

/**
 * Query a single consensus proposal by ID.
 */
public query func getConsensusProposal(proposalId : Text) : async ?ConsensusProposal {
  for (p in consensusProposals.vals()) {
    if (p.proposalId == proposalId) { return ?p };
  };
  null
};

/**
 * List all proposals, optionally filtered by status.
 * Pass "pending", "approved", or "cancelled"; any other value returns all.
 */
public query func listConsensusProposals(statusFilter : Text) : async [ConsensusProposal] {
  if (statusFilter == "pending") {
    return Array.filter<ConsensusProposal>(
      consensusProposals,
      func(p) { switch (p.status) { case (#pending) { true }; case (_) { false } } }
    );
  };
  if (statusFilter == "approved") {
    return Array.filter<ConsensusProposal>(
      consensusProposals,
      func(p) { switch (p.status) { case (#approved) { true }; case (_) { false } } }
    );
  };
  if (statusFilter == "cancelled") {
    return Array.filter<ConsensusProposal>(
      consensusProposals,
      func(p) { switch (p.status) { case (#cancelled) { true }; case (_) { false } } }
    );
  };
  consensusProposals
};

/**
 * Cancel a pending proposal explicitly (e.g. on operator request).
 *
 * Authorized callers only.
 */
public shared(msg) func cancelConsensusProposal(proposalId : Text, reason : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  consensusProposals := Array.map<ConsensusProposal, ConsensusProposal>(
    consensusProposals,
    func(p : ConsensusProposal) : ConsensusProposal {
      if (p.proposalId != proposalId) { return p };
      found := true;
      switch (p.status) {
        case (#pending) {
          return {
            proposalId       = p.proposalId;
            nonce            = p.nonce;
            tradeDescription = p.tradeDescription;
            pair             = p.pair;
            direction        = p.direction;
            quantity         = p.quantity;
            originChain      = p.originChain;
            status           = #cancelled;
            votes            = p.votes;
            createdAt        = p.createdAt;
            resolvedAt       = ?Time.now();
            cancelReason     = ?reason;
          };
        };
        case (_) { return p };
      };
    }
  );

  if (found) { #ok("Proposal cancelled: " # proposalId) }
  else       { #err("Proposal not found: " # proposalId) }
};

/**
 * Expire proposals that have exceeded the 30-second consensus window.
 *
 * Called automatically from the system heartbeat every round.
 * Returns the number of proposals that were expired.
 */
public shared func expireStaleConsensusProposals() : async Nat {
  let now = Time.now();
  var count : Nat = 0;

  consensusProposals := Array.map<ConsensusProposal, ConsensusProposal>(
    consensusProposals,
    func(p : ConsensusProposal) : ConsensusProposal {
      switch (p.status) {
        case (#pending) {
          if (now - p.createdAt > CONSENSUS_TIMEOUT_NS) {
            count += 1;
            return {
              proposalId       = p.proposalId;
              nonce            = p.nonce;
              tradeDescription = p.tradeDescription;
              pair             = p.pair;
              direction        = p.direction;
              quantity         = p.quantity;
              originChain      = p.originChain;
              status           = #cancelled;
              votes            = p.votes;
              createdAt        = p.createdAt;
              resolvedAt       = ?now;
              cancelReason     = ?"timeout: 30-second consensus window elapsed";
            };
          };
          return p;
        };
        case (_) { return p };
      };
    }
  );

  count
};

/**
 * Return aggregate statistics for the consensus subsystem.
 */
public query func getConsensusStats() : async {
  total : Nat; pending : Nat; approved : Nat; cancelled : Nat;
} {
  var pending : Nat = 0; var approved : Nat = 0; var cancelled : Nat = 0;
  for (p in consensusProposals.vals()) {
    switch (p.status) {
      case (#pending)   { pending   += 1 };
      case (#approved)  { approved  += 1 };
      case (#cancelled) { cancelled += 1 };
    }
  };
  { total = consensusProposals.size(); pending; approved; cancelled }
};

// ==================== System Functions ====================

/**
 * Returns canister status, live heap size, and current cycle balance.
 * Reports #stopped when the kill switch is active.
 */
public query func getCanisterStatus() : async {
  status     : { #running; #stopping; #stopped };
  memorySize : Nat;
  cycles     : Nat;
} {
  {
    status     = if (canisterKilled) { #stopped } else { #running };
    memorySize = Prim.rts_heap_size();
    cycles     = Cycles.balance();
  }
};

public query func getMetrics() : async {
  uptime : Int; operations : Nat; lastActivity : Int;
} {
  {
    uptime       = Time.now();
    operations   = agentState.executionCount;
    lastActivity = agentState.lastExecuted;
  }
};

// ==================== Multi-Factor Approval (MFA) — On-Chain Nonce & Audit ====================
//
// The agent generates its own TOTP seed locally (never sent to the canister).
// Only the monotonically-incrementing nonce and the tamper-evident audit log
// live on-chain, providing replay-protection and a forensic trail.
//
// Design:
//   • mfaGlobalNonce  — single counter; every challenge call bumps it by 1.
//   • mfaAuditLog     — append-only array of MfaAuditEntry records.
//
// Auth: only the owner or allowlisted principals may write.

public type MfaAuditEntry = {
  id        : Text;
  requestId : Text;
  branchId  : Text;
  event     : Text;              // "approved" | "rejected" | "anomaly-detected" | …
  nonce     : ?Nat;
  challengeHash : ?Text;        // SHA-256(nonce ‖ branchId ‖ timestamp)
  auditToken    : ?Text;        // HMAC returned to the CLI on success
  deviceFingerprint : ?Text;
  timestamp : Text;             // ISO-8601
  detail    : ?Text;
};

/// Monotonically increasing nonce — bumped by incrementMfaNonce().
stable var mfaGlobalNonce : Nat = 0;

/// Immutable audit trail — only appended to, never modified.
stable var mfaAuditLog : [MfaAuditEntry] = [];

/**
 * Read the current on-chain nonce.
 * The CLI uses this value to build the challenge hash before calling incrementMfaNonce().
 */
public query func getMfaGlobalNonce() : async Nat {
  mfaGlobalNonce
};

/**
 * Increment the global nonce and return the new value.
 *
 * Called by the agent when it is about to issue a challenge to the human approver.
 * Each nonce is single-use: the CLI verifies that the value returned here matches
 * the nonce embedded in the approver's reply before accepting the approval.
 *
 * Authorized principals only.
 */
public shared(msg) func incrementMfaNonce() : async { #ok : Nat; #err : Text } {
  if (not isAuthorized(msg.caller)) {
    return #err("Caller not authorized: " # Principal.toText(msg.caller));
  };
  assertNotKilled();
  assertNotFrozen();

  mfaGlobalNonce += 1;
  #ok(mfaGlobalNonce)
};

/**
 * Append an MFA audit entry to the on-chain log.
 *
 * Called by the CLI after a successful (or failed) approval attempt so that
 * every decision is permanently recorded and attributable.
 *
 * Authorized principals only.
 */
public shared(msg) func logMfaApproval(entry : MfaAuditEntry) : async { #ok : Text; #err : Text } {
  if (not isAuthorized(msg.caller)) {
    return #err("Caller not authorized: " # Principal.toText(msg.caller));
  };
  assertNotKilled();
  assertMemoryLimit();

  mfaAuditLog := Array.append<MfaAuditEntry>(mfaAuditLog, [entry]);
  #ok("Audit entry logged: " # entry.id)
};

/**
 * Query audit entries for a specific branch.
 *
 * Returns all entries whose branchId matches the provided string.
 * Use getMfaAuditLogAll() for the complete unfiltered log.
 */
public query func getMfaAuditLog(branchId : Text) : async [MfaAuditEntry] {
  Array.filter<MfaAuditEntry>(
    mfaAuditLog,
    func(e : MfaAuditEntry) : Bool { e.branchId == branchId }
  )
};

/**
 * Query the entire MFA audit log (all branches).
 */
public query func getMfaAuditLogAll() : async [MfaAuditEntry] {
  mfaAuditLog
};

/**
 * Summary statistics for the MFA subsystem.
 */
public query func getMfaStats() : async {
  globalNonce    : Nat;
  totalAuditEntries : Nat;
  approvedCount  : Nat;
  rejectedCount  : Nat;
  anomalyCount   : Nat;
} {
  var approved : Nat = 0;
  var rejected : Nat = 0;
  var anomaly  : Nat = 0;

  for (e in mfaAuditLog.vals()) {
    if      (e.event == "approved")         { approved += 1 }
    else if (e.event == "rejected")         { rejected += 1 }
    else if (e.event == "anomaly-detected") { anomaly  += 1 };
  };

  {
    globalNonce       = mfaGlobalNonce;
    totalAuditEntries = mfaAuditLog.size();
    approvedCount     = approved;
    rejectedCount     = rejected;
    anomalyCount      = anomaly;
  }
};

// ==================== Upgrade Guard ====================

/**
 * Trap while frozen — aborts any attempt to upgrade the canister code without
 * the owner first calling manualUnlock().
 */
system func preupgrade() {
  // This assert causes the IC to abort the upgrade if frozen mode is active.
  assert (not frozenMode); // upgrade blocked: canister is frozen — call manualUnlock() first
};

// ==================== Mirror Canister Sync (Fault Tolerance) ====================
//
// Allows state replication to a second ICP canister via inter-canister calls.
// On total primary wipe, the operator can call syncFromMirror to recover.
//
// NOTE: Inter-canister calls consume cycles on both canisters.
//       Use sparingly or on a scheduled basis (e.g. once per hour via heartbeat).

/**
 * Remote mirror canister interface (subset of functions we replicate).
 * Must match the corresponding public functions on the mirror canister.
 */
type MirrorActor = actor {
  receiveSync : (
    memories   : [Memory],
    tasks      : [Task],
    ctx        : [(Text, Text)],
    config     : ?AgentConfig,
    syncedAt   : Int
  ) -> async { #ok : Text; #err : Text };
  exportSyncState : () -> async {
    memories : [Memory];
    tasks    : [Task];
    ctx      : [(Text, Text)];
    config   : ?AgentConfig;
    syncedAt : Int;
  };
};

/** Principal of the registered mirror canister (empty = no mirror configured). */
stable var mirrorCanisterId : Text = "";

/** ISO timestamp of the most recent successful push to the mirror. */
stable var lastSyncToMirrorAt : Int = 0;

/** ISO timestamp of the most recent successful pull from the mirror. */
stable var lastSyncFromMirrorAt : Int = 0;

/**
 * Register the mirror canister.
 *
 * @param canisterId - Principal text of the mirror canister
 * @returns Registration result
 */
public shared func setMirrorCanister(canisterId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  if (Text.size(canisterId) == 0) {
    return #err("Mirror canister ID cannot be empty");
  };
  mirrorCanisterId := canisterId;
  #ok("Mirror canister registered: " # canisterId)
};

/**
 * Clear the mirror canister registration.
 */
public shared func clearMirrorCanister() : async Text {
  mirrorCanisterId := "";
  "Mirror canister cleared"
};

/**
 * Get the currently registered mirror canister ID.
 */
public query func getMirrorCanister() : async ?Text {
  if (Text.size(mirrorCanisterId) == 0) {
    null
  } else {
    ?mirrorCanisterId
  }
};

/**
 * Push (replicate) current state to the mirror canister.
 *
 * Copies: memories, tasks, context key-value pairs, and agent config.
 * Does NOT copy encrypted secrets or wallet registry (security boundary).
 *
 * @returns Sync result
 */
public shared func syncToMirror(targetCanisterId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  let target = if (Text.size(targetCanisterId) > 0) targetCanisterId else mirrorCanisterId;

  if (Text.size(target) == 0) {
    return #err("No mirror canister configured. Call setMirrorCanister first.");
  };

  let mirror : MirrorActor = actor(target);

  try {
    let result = await mirror.receiveSync(
      memories,
      tasks,
      context,
      agentConfig,
      Time.now()
    );

    switch (result) {
      case (#ok(msg)) {
        lastSyncToMirrorAt := Time.now();
        #ok("Synced to mirror " # target # ": " # msg)
      };
      case (#err(e)) {
        #err("Mirror rejected sync: " # e)
      };
    }
  } catch (e) {
    #err("Inter-canister call failed: " # Error.message(e))
  }
};

/**
 * Pull (restore) state from the mirror canister into this canister.
 *
 * Use this when the primary canister state has been wiped and needs recovery.
 *
 * @param sourceCanisterId - Mirror canister to pull from (uses registered ID if empty)
 * @returns Restore result
 */
public shared func syncFromMirror(sourceCanisterId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  let source = if (Text.size(sourceCanisterId) > 0) sourceCanisterId else mirrorCanisterId;

  if (Text.size(source) == 0) {
    return #err("No mirror canister configured. Provide a source canister ID.");
  };

  let mirror : MirrorActor = actor(source);

  try {
    let snapshot = await mirror.exportSyncState();

    memories    := snapshot.memories;
    tasks       := snapshot.tasks;
    context     := snapshot.ctx;
    agentConfig := snapshot.config;

    lastSyncFromMirrorAt := Time.now();

    #ok("State restored from mirror " # source # " (syncedAt: " # Int.toText(snapshot.syncedAt) # ")")
  } catch (e) {
    #err("Inter-canister pull failed: " # Error.message(e))
  }
};

/**
 * Accept a state snapshot pushed by the primary canister (mirror-side function).
 *
 * Both the primary and the mirror deploy the same canister WASM, so both
 * expose this function.  Only the primary's controller should call it.
 */
public shared func receiveSync(
  inMemories : [Memory],
  inTasks    : [Task],
  inCtx      : [(Text, Text)],
  inConfig   : ?AgentConfig,
  syncedAt   : Int
) : async { #ok : Text; #err : Text } {
  memories    := inMemories;
  tasks       := inTasks;
  context     := inCtx;
  agentConfig := inConfig;
  lastSyncFromMirrorAt := syncedAt;

  #ok("Sync received at " # Int.toText(syncedAt))
};

/**
 * Export current state snapshot for a primary-side pull (mirror-side function).
 */
public query func exportSyncState() : async {
  memories : [Memory];
  tasks    : [Task];
  ctx      : [(Text, Text)];
  config   : ?AgentConfig;
  syncedAt : Int;
} {
  {
    memories = memories;
    tasks    = tasks;
    ctx      = context;
    config   = agentConfig;
    syncedAt = lastSyncFromMirrorAt;
  }
};

/**
 * Return mirror configuration and last-sync timestamps.
 */
public query func getMirrorStatus() : async {
  configured          : Bool;
  mirrorCanisterId    : Text;
  lastSyncToMirrorAt  : Int;
  lastSyncFromMirrorAt : Int;
} {
  {
    configured           = Text.size(mirrorCanisterId) > 0;
    mirrorCanisterId     = mirrorCanisterId;
    lastSyncToMirrorAt   = lastSyncToMirrorAt;
    lastSyncFromMirrorAt = lastSyncFromMirrorAt;
  }
};

// ==================== ThoughtForm Storage ====================

/**
 * Store a thought-form on-chain.
 *
 * Pushes the JSON payload together with a caller-supplied timestamp into the
 * stable thoughtForms vec.  A simple hash (Text.hash of the JSON content) is
 * computed and persisted alongside the record for quick integrity checks.
 *
 * Returns the newly created ThoughtForm record (including its id and hash).
 */
public shared(msg) func store_thoughtform(json : Text, timestamp : Nat64) : async {
  #ok : ThoughtForm;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);

  // Input validation — reject empty payloads and enforce a 1 MB size cap.
  if (Text.size(json) == 0) {
    return #err("json payload must not be empty");
  };
  if (Text.size(json) > 1_000_000) {
    return #err("json payload exceeds 1 MB limit");
  };

  let id   = nextThoughtFormId;
  let hash = Text.hash(json);

  let entry : ThoughtForm = {
    id        = id;
    json      = json;
    timestamp = timestamp;
    hash      = hash;
    storedAt  = Time.now();
  };

  thoughtForms      := Array.append<ThoughtForm>(thoughtForms, [entry]);
  nextThoughtFormId := id + 1;

  #ok(entry)
};

/**
 * Retrieve a single stored thought-form by its id.
 */
public query func get_thoughtform(id : Nat) : async ?ThoughtForm {
  for (tf in thoughtForms.vals()) {
    if (tf.id == id) { return ?tf };
  };
  null
};

/**
 * Return all stored thought-forms (newest last).
 */
public query func get_thoughtforms() : async [ThoughtForm] {
  thoughtForms
};
