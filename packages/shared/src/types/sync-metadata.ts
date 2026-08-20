/**
 * Sync metadata for linking Paperclip entities to external fleet systems.
 *
 * Used by Goals and Routines to store references to:
 * - Beads task IDs (task-level SSOT)
 * - Linear labels (read-only project map)
 * - Ringer manifest references (Judge/Typist execution)
 *
 * Architecture: JAC-3473 §4.1 — layered SSOT boundaries.
 */
export interface SyncMetadata {
  /** Beads issue/epic ID for task-level sync */
  beadsTaskId?: string | null;

  /** Linear label/epic reference for read-only project map */
  linearLabel?: string | null;

  /** Ringer manifest reference (swarm.json path or run ID) */
  ringerManifestRef?: string | null;

  /** Additional sync IDs for future integrations */
  [key: string]: string | null | undefined;
}