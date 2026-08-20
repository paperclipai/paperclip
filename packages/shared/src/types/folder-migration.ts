import type { AgentFolder } from "./agent-folders.js";

/**
 * Result of a flat-to-folder migration operation.
 */
export interface MigrationResult {
  totalUnassigned: number;
  groupsCreated: string[];
  foldersCreated: string[];
  foldersReused: number;
}

/**
 * An agent with a broken folder reference — the folder doesn't exist in the DB.
 */
export interface BrokenFolderReference {
  agentId: string;
  agentName: string;
  folderId: string;
  reason: "folder_not_found";
}

/**
 * A folder whose parent chain is broken or cyclic.
 */
export interface BrokenFolderChain {
  folderId: string;
  folderName: string;
  reason: "missing_parent" | "cycle";
}

/**
 * A cycle detected in the folder hierarchy.
 */
export interface FolderCycle {
  folderId: string;
  chain: string[];
}

/**
 * An agent whose folder exists but the folder-level AGENTS.md is missing.
 */
export interface MissingFolderInstructions {
  agentId: string;
  agentName: string;
  folderId: string;
  folderName: string;
  instructionsDir: string;
}

/**
 * An agent with both external instructions and folder-level instructions — potential conflict.
 */
export interface ConflictingExternalFolderInstructions {
  agentId: string;
  agentName: string;
  folderId: string;
  folderName: string;
}

/**
 * An agent whose managed instructions root doesn't match the expected folder path.
 */
export interface MisalignedInstructionsRoot {
  agentId: string;
  agentName: string;
  folderId: string;
  folderName: string;
  configuredRoot: string;
  expectedRoot: string;
}

/**
 * Result of validating the agent-folder inheritance chain for a company.
 */
export interface InheritanceValidationResult {
  /** Total number of agents in the company. */
  totalAgents: number;
  /** Total number of agents filed under a folder. */
  agentsInFolders: number;
  /** Total number of agents still flat (no folder). */
  agentsUnassigned: number;
  /** Agents pointing to folders that don't exist. */
  brokenFolderReferences: BrokenFolderReference[];
  /** Folders with broken parent chains or cycles. */
  brokenFolderChains: BrokenFolderChain[];
  /** Cycles in the folder hierarchy. */
  folderCycles: FolderCycle[];
  /** Agents whose folder-level AGENTS.md is missing. */
  missingFolderInstructions: MissingFolderInstructions[];
  /** Agents with both external and folder instructions (potential conflict). */
  conflictingExternalFolderInstructions: ConflictingExternalFolderInstructions[];
  /** Agents whose managed instructions root is misaligned. */
  misalignedInstructionsRoots: MisalignedInstructionsRoot[];
  /** Total number of issues found. */
  issueCount: number;
}
