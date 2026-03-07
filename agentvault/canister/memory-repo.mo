/**
 * MemoryRepo Canister — Git-Style Memory System for AgentVault (Hardened)
 *
 * Provides version-controlled memory with commits, branches, rebase, and merge.
 * Agents get genesis commits from Soul.md documents, branching histories,
 * and on-chain memory versioning.
 *
 * Security hardening applied:
 *
 *  1. HEAP LIMIT — Prim.rts_heap_size() checked on every write call; aborts at 64 MB.
 *  2. PRINCIPAL GUARDS — All state-mutating functions require an authorized caller.
 *     Owner is claimed on first call to initRepo(); subsequent attempts rejected.
 *  3. ALLOWED PRINCIPALS — Owner can grant/revoke write access to other principals.
 *  4. FROZEN MODE — Owner can freeze canister; all writes blocked until manualUnlock().
 *  5. KILL SWITCH — Owner can kill canister; all non-owner writes blocked until revive.
 *  6. INPUT VALIDATION — All string inputs bounded. Commit/branch/tag counts capped.
 *  7. PREUPGRADE GUARD — Traps if frozen, preventing unauthorized code upgrades.
 *  8. MONOTONIC IDS — Sequential counter prevents ID collisions under concurrency.
 *  9. DEPTH-LIMITED WALKS — Parent chain traversal capped to prevent infinite loops.
 */

import Int       "mo:base/Int";
import Nat       "mo:base/Nat";
import Time      "mo:base/Time";
import Text      "mo:base/Text";
import Array     "mo:base/Array";
import Principal "mo:base/Principal";
import Nat64     "mo:base/Nat64";
import Prim      "mo:prim";
import Debug     "mo:base/Debug";
import Order     "mo:base/Order";

actor MemoryRepo {

  // ==================== Constants ====================

  let ANON : Principal = Principal.fromText("2vxsx-fae");
  let MAX_HEAP_BYTES   : Nat  = 67_108_864;  // 64 MB
  let MAX_COMMITS      : Nat  = 10_000;
  let MAX_BRANCHES     : Nat  = 100;
  let MAX_DIFF_BYTES   : Nat  = 1_048_576;   // 1 MB
  let MAX_MESSAGE_BYTES: Nat  = 1_024;
  let MAX_TAG_BYTES    : Nat  = 128;
  let MAX_TAGS         : Nat  = 20;
  let MAX_BRANCH_NAME  : Nat  = 64;
  let MAX_CHAIN_DEPTH  : Nat  = 10_000;
  let MAX_THOUGHT_FORMS: Nat  = 10_000;
  let MAX_THOUGHT_JSON : Nat  = 1_048_576;  // 1 MB
  let MAX_THOUGHT_HASH : Nat  = 128;

  // ==================== Types ====================

  public type Commit = {
    id        : Text;
    timestamp : Int;
    message   : Text;
    diff      : Text;
    tags      : [Text];
    parent    : ?Text;
    branch    : Text;
  };

  public type RebaseResult = {
    #ok : { newBranch : Text; commitsReplayed : Nat };
    #err : Text;
  };

  public type MergeStrategy = {
    #auto;
    #manual;
  };

  public type ConflictEntry = {
    commitId  : Text;
    message   : Text;
    tags      : [Text];
    diff      : Text;
  };

  public type MergeResult = {
    #ok : { merged : Nat; message : Text };
    #conflicts : [ConflictEntry];
    #err : Text;
  };

  public type RepoStatus = {
    initialized   : Bool;
    currentBranch : Text;
    totalCommits  : Nat;
    totalBranches : Nat;
    owner         : Text;
  };

  public type SecurityStatus = {
    owner             : Text;
    frozenMode        : Bool;
    canisterKilled    : Bool;
    authorizedCount   : Nat;
    heapBytes         : Nat;
  };

  public type ThoughtFormStore = {
    json      : Text;
    timestamp : Nat64;
    hash      : Text;
  };

  // ==================== Stable State ====================

  stable var owner             : Principal      = ANON;
  stable var allowedPrincipals : [Principal]     = [];
  stable var initialized       : Bool           = false;
  stable var frozenMode        : Bool           = false;
  stable var canisterKilled    : Bool           = false;
  stable var commits           : [Commit]       = [];
  stable var branches          : [(Text, Text)] = []; // (name, headCommitId)
  stable var currentBranch     : Text           = "main";
  stable var nextCommitSeq     : Nat            = 0;
  stable var thoughtForms      : [ThoughtFormStore] = [];

  // ==================== Upgrade Guards ====================

  system func preupgrade() {
    if (frozenMode) {
      Debug.trap("canister is frozen — call manualUnlock() before upgrading");
    };
  };

  // ==================== Guard Functions ====================

  private func assertNotKilled() {
    if (canisterKilled) {
      Debug.trap("canister killed — call reviveCanister() to restore");
    };
  };

  private func assertMemoryLimit() {
    if (Prim.rts_heap_size() >= MAX_HEAP_BYTES) {
      Debug.trap("heap size >= 64 MB hard limit");
    };
  };

  private func isAuthorized(caller : Principal) : Bool {
    if (Principal.isAnonymous(caller)) { return false };
    if (caller == owner)               { return true  };
    for (p in allowedPrincipals.vals()) {
      if (p == caller) { return true };
    };
    false
  };

  private func assertAuthorized(caller : Principal) {
    if (not isAuthorized(caller)) {
      Debug.trap("caller principal is not authorized");
    };
  };

  private func assertOwner(caller : Principal) {
    if (caller != owner) {
      Debug.trap("only the canister owner may call this function");
    };
  };

  private func assertNotFrozen() {
    if (frozenMode) {
      Debug.trap("canister is frozen — call manualUnlock() first");
    };
  };

  /// Combined write guard: kill switch, memory, auth, freeze — checked in that order.
  private func assertWriteAllowed(caller : Principal) {
    assertNotKilled();
    assertMemoryLimit();
    assertAuthorized(caller);
    assertNotFrozen();
  };

  // ==================== Input Validation ====================

  private func validateDiff(diff : Text) : ?Text {
    if (Text.size(diff) > MAX_DIFF_BYTES) {
      return ?"Diff exceeds maximum size of 1 MB";
    };
    null
  };

  private func validateMessage(message : Text) : ?Text {
    if (Text.size(message) == 0) {
      return ?"Message cannot be empty";
    };
    if (Text.size(message) > MAX_MESSAGE_BYTES) {
      return ?"Message exceeds maximum size of 1024 characters";
    };
    null
  };

  private func validateTags(tags : [Text]) : ?Text {
    if (tags.size() > MAX_TAGS) {
      return ?"Too many tags (maximum " # Nat.toText(MAX_TAGS) # ")";
    };
    for (t in tags.vals()) {
      if (Text.size(t) == 0) {
        return ?"Tag cannot be empty";
      };
      if (Text.size(t) > MAX_TAG_BYTES) {
        return ?"Tag exceeds maximum size of 128 characters";
      };
    };
    null
  };

  private func validateBranchName(name : Text) : ?Text {
    if (Text.size(name) == 0) {
      return ?"Branch name cannot be empty";
    };
    if (Text.size(name) > MAX_BRANCH_NAME) {
      return ?"Branch name exceeds maximum of 64 characters";
    };
    null
  };

  private func validateSoulContent(content : Text) : ?Text {
    if (Text.size(content) == 0) {
      return ?"Soul content cannot be empty";
    };
    if (Text.size(content) > MAX_DIFF_BYTES) {
      return ?"Soul content exceeds maximum size of 1 MB";
    };
    null
  };

  // ==================== ID Generation ====================

  /// Monotonically incrementing commit ID — immune to Time.now() collisions.
  private func generateCommitId() : Text {
    let id = "c_" # Int.toText(Time.now()) # "_" # Nat.toText(nextCommitSeq);
    nextCommitSeq += 1;
    id
  };

  // ==================== Helper Functions ====================

  /// Get the HEAD commit ID for a branch, or null if not found.
  private func getBranchHead(branchName : Text) : ?Text {
    for ((name, head) in branches.vals()) {
      if (name == branchName) { return ?head };
    };
    null
  };

  /// Update the HEAD of a branch to point to a new commit ID.
  /// Returns false if branch not found (should not happen in normal operation).
  private func updateBranchHead(branchName : Text, commitId : Text) : Bool {
    var found = false;
    branches := Array.map<(Text, Text), (Text, Text)>(
      branches,
      func (entry : (Text, Text)) : (Text, Text) {
        if (entry.0 == branchName) {
          found := true;
          (branchName, commitId)
        } else { entry }
      }
    );
    found
  };

  /// Collect all commits on a branch by following the parent chain from HEAD.
  /// Depth-limited to MAX_CHAIN_DEPTH to prevent infinite loops from circular refs.
  private func collectBranchCommits(branchName : Text) : [Commit] {
    switch (getBranchHead(branchName)) {
      case null { [] };
      case (?headId) {
        var result : [Commit] = [];
        var currentId : ?Text = ?headId;
        var depth : Nat = 0;
        label walk loop {
          if (depth >= MAX_CHAIN_DEPTH) { break walk };
          switch (currentId) {
            case null { break walk };
            case (?cid) {
              var found = false;
              for (c in commits.vals()) {
                if (c.id == cid) {
                  result := Array.append<Commit>(result, [c]);
                  currentId := c.parent;
                  found := true;
                };
              };
              if (not found) { break walk };
              depth += 1;
            };
          };
        };
        result
      };
    };
  };

  /// Find a commit by ID.
  private func findCommit(commitId : Text) : ?Commit {
    for (c in commits.vals()) {
      if (c.id == commitId) { return ?c };
    };
    null
  };

  /// Check if two tag arrays have overlapping entries.
  private func tagsOverlap(a : [Text], b : [Text]) : Bool {
    for (ta in a.vals()) {
      for (tb in b.vals()) {
        if (ta == tb) { return true };
      };
    };
    false
  };

  /// Check if a branch name already exists.
  private func branchExists(name : Text) : Bool {
    for ((n, _) in branches.vals()) {
      if (n == name) { return true };
    };
    false
  };

  // ==================== Owner & Security Management ====================

  /// Freeze the canister — all writes blocked until manualUnlock().
  public shared(msg) func freeze() : async { #ok : Text; #err : Text } {
    assertNotKilled();
    assertAuthorized(msg.caller);
    assertOwner(msg.caller);
    frozenMode := true;
    #ok("Canister frozen — call manualUnlock() to re-enable writes")
  };

  /// Unfreeze the canister — re-enable writes. Owner only.
  public shared(msg) func manualUnlock() : async { #ok : Text; #err : Text } {
    assertNotKilled();
    assertOwner(msg.caller);
    frozenMode := false;
    #ok("Canister unfrozen — writes re-enabled")
  };

  /// Kill switch — block all non-owner writes. Owner only.
  public shared(msg) func killCanister() : async { #ok : Text; #err : Text } {
    assertOwner(msg.caller);
    canisterKilled := true;
    #ok("Canister killed — call reviveCanister() to restore")
  };

  /// Revive canister after kill switch. Owner only.
  public shared(msg) func reviveCanister() : async { #ok : Text; #err : Text } {
    assertOwner(msg.caller);
    canisterKilled := false;
    #ok("Canister revived — writes re-enabled")
  };

  /// Add an authorized principal (owner only).
  public shared(msg) func addAuthorizedPrincipal(p : Principal) : async { #ok : Text; #err : Text } {
    assertWriteAllowed(msg.caller);
    assertOwner(msg.caller);

    if (Principal.isAnonymous(p)) {
      return #err("Cannot authorize anonymous principal");
    };

    // Check if already authorized
    for (existing in allowedPrincipals.vals()) {
      if (existing == p) {
        return #err("Principal already authorized");
      };
    };

    allowedPrincipals := Array.append<Principal>(allowedPrincipals, [p]);
    #ok("Principal authorized: " # Principal.toText(p))
  };

  /// Remove an authorized principal (owner only).
  public shared(msg) func removeAuthorizedPrincipal(p : Principal) : async { #ok : Text; #err : Text } {
    assertWriteAllowed(msg.caller);
    assertOwner(msg.caller);

    let filtered = Array.filter<Principal>(allowedPrincipals, func (x : Principal) : Bool { x != p });
    if (filtered.size() == allowedPrincipals.size()) {
      return #err("Principal not found in authorized list");
    };

    allowedPrincipals := filtered;
    #ok("Principal removed: " # Principal.toText(p))
  };

  /// Query security status.
  public query func getSecurityStatus() : async SecurityStatus {
    {
      owner          = Principal.toText(owner);
      frozenMode     = frozenMode;
      canisterKilled = canisterKilled;
      authorizedCount = allowedPrincipals.size();
      heapBytes      = Prim.rts_heap_size();
    }
  };

  // ==================== Public API ====================

  /// Initialize the repository with a genesis commit from soul content.
  /// Sets caller as owner. Can only be called once.
  public shared(msg) func initRepo(soulContent : Text) : async { #ok : Text; #err : Text } {
    if (initialized) {
      return #err("Repository already initialized");
    };

    assertMemoryLimit();
    if (Principal.isAnonymous(msg.caller)) {
      return #err("Anonymous principal cannot initialize repository");
    };

    switch (validateSoulContent(soulContent)) {
      case (?e) { return #err(e) };
      case null {};
    };

    owner := msg.caller;
    initialized := true;

    let genesisId = generateCommitId();
    let genesis : Commit = {
      id        = genesisId;
      timestamp = Time.now();
      message   = "Genesis: Initialize from Soul.md";
      diff      = soulContent;
      tags      = ["genesis", "soul"];
      parent    = null;
      branch    = "main";
    };

    commits := [genesis];
    branches := [("main", genesisId)];
    currentBranch := "main";

    #ok(genesisId)
  };

  /// Create a new commit on the current branch.
  public shared(msg) func commit(message : Text, diff : Text, tags : [Text]) : async { #ok : Text; #err : Text } {
    assertWriteAllowed(msg.caller);

    if (not initialized) {
      return #err("Repository not initialized — call initRepo first");
    };

    if (commits.size() >= MAX_COMMITS) {
      return #err("Commit limit reached (" # Nat.toText(MAX_COMMITS) # ") — archive old commits before adding more");
    };

    switch (validateMessage(message)) {
      case (?e) { return #err(e) };
      case null {};
    };
    switch (validateDiff(diff)) {
      case (?e) { return #err(e) };
      case null {};
    };
    switch (validateTags(tags)) {
      case (?e) { return #err(e) };
      case null {};
    };

    let parentId = getBranchHead(currentBranch);
    let commitId = generateCommitId();

    let newCommit : Commit = {
      id        = commitId;
      timestamp = Time.now();
      message   = message;
      diff      = diff;
      tags      = tags;
      parent    = parentId;
      branch    = currentBranch;
    };

    commits := Array.append<Commit>(commits, [newCommit]);
    ignore updateBranchHead(currentBranch, commitId);

    #ok(commitId)
  };

  /// Query the commit log for a branch (newest first).
  public query func log(branchName : ?Text) : async [Commit] {
    let target = switch (branchName) {
      case null { currentBranch };
      case (?b) { b };
    };
    collectBranchCommits(target)
  };

  /// Get the current state (diff of HEAD commit on current branch).
  public query func getCurrentState() : async ?Text {
    switch (getBranchHead(currentBranch)) {
      case null { null };
      case (?headId) {
        switch (findCommit(headId)) {
          case null { null };
          case (?c) { ?c.diff };
        };
      };
    };
  };

  /// Get all branches with their HEAD commit IDs.
  public query func getBranches() : async [(Text, Text)] {
    branches
  };

  /// Create a new branch pointing at the current branch's HEAD.
  public shared(msg) func createBranch(name : Text) : async { #ok : Text; #err : Text } {
    assertWriteAllowed(msg.caller);

    if (not initialized) {
      return #err("Repository not initialized");
    };

    if (branches.size() >= MAX_BRANCHES) {
      return #err("Branch limit reached (" # Nat.toText(MAX_BRANCHES) # ")");
    };

    switch (validateBranchName(name)) {
      case (?e) { return #err(e) };
      case null {};
    };

    if (branchExists(name)) {
      return #err("Branch '" # name # "' already exists");
    };

    let headId = switch (getBranchHead(currentBranch)) {
      case null { return #err("Current branch has no commits") };
      case (?h) { h };
    };

    branches := Array.append<(Text, Text)>(branches, [(name, headId)]);
    #ok("Branch '" # name # "' created at " # headId)
  };

  /// Switch to a different branch.
  public shared(msg) func switchBranch(name : Text) : async { #ok : Text; #err : Text } {
    assertWriteAllowed(msg.caller);

    if (not branchExists(name)) {
      return #err("Branch '" # name # "' does not exist");
    };

    currentBranch := name;
    #ok("Switched to branch '" # name # "'")
  };

  /// Get a specific commit by ID.
  public query func getCommit(commitId : Text) : async ?Commit {
    findCommit(commitId)
  };

  /// Get repository status.
  public query func getRepoStatus() : async RepoStatus {
    {
      initialized   = initialized;
      currentBranch = currentBranch;
      totalCommits  = commits.size();
      totalBranches = branches.size();
      owner         = Principal.toText(owner);
    }
  };

  // ==================== ThoughtForm Queries ====================

  /// Fetch thoughtform entries as JSON text strings.
  /// Filters commits tagged "thoughtform" with timestamp > since (or all if null).
  /// Returns diff (JSON) payloads sorted by timestamp descending.
  /// Decryption is stubbed — encrypted payloads returned as-is for now.
  public query func fetch_thoughtforms(since : ?Int) : async [Text] {
    // Filter commits that carry the "thoughtform" tag
    let thoughtforms = Array.filter<Commit>(commits, func (c : Commit) : Bool {
      let hasTag = Array.find<Text>(c.tags, func (t : Text) : Bool { t == "thoughtform" });
      switch (hasTag) {
        case null { return false };
        case (?_) {};
      };
      // Apply timestamp filter
      switch (since) {
        case null { true };
        case (?s) { c.timestamp > s };
      };
    });

    // Sort by timestamp descending
    let sorted = Array.sort<Commit>(thoughtforms, func (a : Commit, b : Commit) : Order.Order {
      Int.compare(b.timestamp, a.timestamp)
    });

    // Map to JSON text (diff field) — decrypt stub: return as-is
    Array.map<Commit, Text>(sorted, func (c : Commit) : Text { c.diff })
  };

  // ==================== PRD 3: Rebase ====================

  /// Rebase: create a new branch with a new genesis from newBaseSoul,
  /// then replay all non-genesis commits from targetBranch.
  /// Original branch is preserved (non-destructive).
  public shared(msg) func rebase(newBaseSoul : Text, targetBranch : ?Text) : async RebaseResult {
    assertWriteAllowed(msg.caller);

    if (not initialized) {
      return #err("Repository not initialized");
    };

    switch (validateSoulContent(newBaseSoul)) {
      case (?e) { return #err(e) };
      case null {};
    };

    let sourceBranch = switch (targetBranch) {
      case null { currentBranch };
      case (?b) { b };
    };

    // Collect commits from source branch (HEAD first)
    let branchCommits = collectBranchCommits(sourceBranch);
    if (branchCommits.size() == 0) {
      return #err("Branch '" # sourceBranch # "' has no commits");
    };

    // Check commit capacity
    let nonGenesisCount = Array.filter<Commit>(branchCommits, func (c : Commit) : Bool {
      switch (Array.find<Text>(c.tags, func (t : Text) : Bool { t == "genesis" })) {
        case (?_) { false };
        case null { true };
      };
    }).size();

    if (commits.size() + nonGenesisCount + 1 > MAX_COMMITS) {
      return #err("Rebase would exceed commit limit (" # Nat.toText(MAX_COMMITS) # ")");
    };

    if (branches.size() >= MAX_BRANCHES) {
      return #err("Branch limit reached (" # Nat.toText(MAX_BRANCHES) # ")");
    };

    // Reverse to get chronological order (oldest first)
    let chronological = Array.reverse(branchCommits);

    // Create unique rebase branch name using monotonic counter
    var rebaseBranch = "rebase/" # Nat.toText(nextCommitSeq);
    // Ensure no collision (defensive)
    while (branchExists(rebaseBranch)) {
      rebaseBranch := rebaseBranch # "_1";
    };

    // Create new genesis commit
    let genesisId = generateCommitId();
    let genesis : Commit = {
      id        = genesisId;
      timestamp = Time.now();
      message   = "Genesis: Rebase from new Soul.md";
      diff      = newBaseSoul;
      tags      = ["genesis", "soul", "rebase"];
      parent    = null;
      branch    = rebaseBranch;
    };
    commits := Array.append<Commit>(commits, [genesis]);
    branches := Array.append<(Text, Text)>(branches, [(rebaseBranch, genesisId)]);

    // Replay non-genesis commits
    var lastId = genesisId;
    var replayed : Nat = 0;

    for (c in chronological.vals()) {
      // Skip genesis commits
      let isGenesis = Array.find<Text>(c.tags, func (t : Text) : Bool { t == "genesis" });
      switch (isGenesis) {
        case (?_) {}; // skip genesis
        case null {
          let newId = generateCommitId();
          let replayed_commit : Commit = {
            id        = newId;
            timestamp = Time.now();
            message   = c.message;
            diff      = c.diff;
            tags      = c.tags;
            parent    = ?lastId;
            branch    = rebaseBranch;
          };
          commits := Array.append<Commit>(commits, [replayed_commit]);
          lastId := newId;
          replayed += 1;
        };
      };
    };

    // Update rebase branch HEAD
    ignore updateBranchHead(rebaseBranch, lastId);

    #ok({ newBranch = rebaseBranch; commitsReplayed = replayed })
  };

  // ==================== PRD 4: Merge & Cherry-Pick ====================

  /// Merge commits from fromBranch into the current branch.
  /// Auto strategy: append non-conflicting, return conflicts if any.
  /// Manual strategy: always return conflict list.
  public shared(msg) func merge(fromBranch : Text, strategy : MergeStrategy) : async MergeResult {
    assertWriteAllowed(msg.caller);

    if (not initialized) {
      return #err("Repository not initialized");
    };

    // Check fromBranch exists
    switch (getBranchHead(fromBranch)) {
      case null { return #err("Branch '" # fromBranch # "' does not exist") };
      case _ {};
    };

    if (fromBranch == currentBranch) {
      return #err("Cannot merge a branch into itself");
    };

    let sourceCommits = collectBranchCommits(fromBranch);
    let targetCommits = collectBranchCommits(currentBranch);

    // Build set of target commit IDs for deduplication
    let targetIds = Array.map<Commit, Text>(targetCommits, func (c : Commit) : Text { c.id });

    var conflicts : [ConflictEntry] = [];
    var toMerge : [Commit] = [];

    for (sc in sourceCommits.vals()) {
      // Skip genesis commits
      let isGenesis = Array.find<Text>(sc.tags, func (t : Text) : Bool { t == "genesis" });
      switch (isGenesis) {
        case (?_) {}; // skip genesis
        case null {
          // Skip commits already in target (by ID)
          var alreadyInTarget = false;
          for (tid in targetIds.vals()) {
            if (tid == sc.id) { alreadyInTarget := true };
          };
          if (alreadyInTarget) {
            // skip — commit already exists in target branch
          } else {
            // Check for conflicts: overlapping tags but different diff
            var hasConflict = false;
            for (tc in targetCommits.vals()) {
              if (tagsOverlap(sc.tags, tc.tags) and sc.diff != tc.diff) {
                hasConflict := true;
              };
            };

            if (hasConflict) {
              conflicts := Array.append<ConflictEntry>(conflicts, [{
                commitId = sc.id;
                message  = sc.message;
                tags     = sc.tags;
                diff     = sc.diff;
              }]);
            } else {
              toMerge := Array.append<Commit>(toMerge, [sc]);
            };
          };
        };
      };
    };

    switch (strategy) {
      case (#manual) {
        // Always return conflict list for cherry-pick
        var allEntries : [ConflictEntry] = conflicts;
        for (c in toMerge.vals()) {
          allEntries := Array.append<ConflictEntry>(allEntries, [{
            commitId = c.id;
            message  = c.message;
            tags     = c.tags;
            diff     = c.diff;
          }]);
        };
        #conflicts(allEntries)
      };
      case (#auto) {
        if (conflicts.size() > 0) {
          #conflicts(conflicts)
        } else {
          // Check commit capacity
          if (commits.size() + toMerge.size() > MAX_COMMITS) {
            return #err("Merge would exceed commit limit (" # Nat.toText(MAX_COMMITS) # ")");
          };

          // Merge non-conflicting commits
          var merged : Nat = 0;
          var lastHead = getBranchHead(currentBranch);

          for (c in Array.reverse(toMerge).vals()) {
            let newId = generateCommitId();
            let mergedCommit : Commit = {
              id        = newId;
              timestamp = Time.now();
              message   = "merge: " # c.message;
              diff      = c.diff;
              tags      = Array.append<Text>(c.tags, ["merged"]);
              parent    = lastHead;
              branch    = currentBranch;
            };
            commits := Array.append<Commit>(commits, [mergedCommit]);
            lastHead := ?newId;
            merged += 1;
          };

          switch (lastHead) {
            case null {};
            case (?h) { ignore updateBranchHead(currentBranch, h) };
          };

          #ok({ merged = merged; message = "Merged " # Nat.toText(merged) # " commit(s) from '" # fromBranch # "'" })
        }
      };
    };
  };

  /// Cherry-pick a single commit by ID onto the current branch.
  public shared(msg) func cherryPick(commitId : Text) : async { #ok : Text; #err : Text } {
    assertWriteAllowed(msg.caller);

    if (not initialized) {
      return #err("Repository not initialized");
    };

    if (commits.size() >= MAX_COMMITS) {
      return #err("Commit limit reached (" # Nat.toText(MAX_COMMITS) # ")");
    };

    switch (findCommit(commitId)) {
      case null { #err("Commit '" # commitId # "' not found") };
      case (?source) {
        let parentId = getBranchHead(currentBranch);
        let newId = generateCommitId();

        let picked : Commit = {
          id        = newId;
          timestamp = Time.now();
          message   = "cherry-pick: " # source.message;
          diff      = source.diff;
          tags      = Array.append<Text>(source.tags, ["cherry-picked"]);
          parent    = parentId;
          branch    = currentBranch;
        };

        commits := Array.append<Commit>(commits, [picked]);
        ignore updateBranchHead(currentBranch, newId);

        #ok(newId)
      };
    };
  };

  // ==================== PRD 5: ThoughtForm Memory ====================

  /// Store a new ThoughtForm entry.
  public shared(msg) func storeThoughtForm(json : Text, timestamp : Nat64, hash : Text) : async { #ok : Text; #err : Text } {
    assertWriteAllowed(msg.caller);

    if (not initialized) {
      return #err("Repository not initialized — call initRepo first");
    };

    if (thoughtForms.size() >= MAX_THOUGHT_FORMS) {
      return #err("ThoughtForm limit reached (" # Nat.toText(MAX_THOUGHT_FORMS) # ")");
    };

    if (Text.size(json) == 0) {
      return #err("ThoughtForm json cannot be empty");
    };
    if (Text.size(json) > MAX_THOUGHT_JSON) {
      return #err("ThoughtForm json exceeds maximum size of 1 MB");
    };
    if (Text.size(hash) == 0) {
      return #err("ThoughtForm hash cannot be empty");
    };
    if (Text.size(hash) > MAX_THOUGHT_HASH) {
      return #err("ThoughtForm hash exceeds maximum size of 128 characters");
    };

    // Reject duplicate hashes
    for (tf in thoughtForms.vals()) {
      if (tf.hash == hash) {
        return #err("ThoughtForm with hash '" # hash # "' already exists");
      };
    };

    let entry : ThoughtFormStore = {
      json      = json;
      timestamp = timestamp;
      hash      = hash;
    };

    thoughtForms := Array.append<ThoughtFormStore>(thoughtForms, [entry]);
    #ok(hash)
  };

  /// Query all stored ThoughtForm entries.
  public query func getThoughtForms() : async [ThoughtFormStore] {
    thoughtForms
  };

  /// Query a single ThoughtForm by hash.
  public query func getThoughtFormByHash(hash : Text) : async ?ThoughtFormStore {
    for (tf in thoughtForms.vals()) {
      if (tf.hash == hash) { return ?tf };
    };
    null
  };
};
