// Legacy migration service for Work entities (WORK-03)
import type { Db } from '@paperclipai/db';

export interface MigrationBatch {
  batchId: string;
  startedAt: Date;
  completedAt?: Date;
  totalRows: number;
  migratedRows: number;
  archivedRows: number;
  skippedRows: number;
  errors: MigrationError[];
}

export interface MigrationError {
  rowId: string;
  error: string;
  timestamp: Date;
}

export interface MigrationStatus {
  isRunning: boolean;
  lastBatch?: MigrationBatch;
  totalMigrated: number;
  totalArchived: number;
}

export function rt2WorkMigrationService(db: any) {
  async function migrateLegacyWorkProducts(options?: {
    batchSize?: number;
    companyId?: string;
    dryRun?: boolean;
  }): Promise<MigrationBatch> {
    // Placeholder implementation: returns a synthetic batch summary
    const batchId = `migration_${Date.now()}`;
    const startedAt = new Date();
    const totalRows = 0;
    const batch: MigrationBatch = {
      batchId,
      startedAt,
      totalRows,
      migratedRows: 0,
      archivedRows: 0,
      skippedRows: totalRows,
      completedAt: new Date(),
      errors: [],
    };
    // In a real implementation, this would iterate legacy rows, insert into rt2_v33_work_entities,
    // archive legacy rows, and update a migration journal.
    return batch;
  }

  async function getMigrationStatus(): Promise<MigrationStatus> {
    // Return a minimal status placeholder
    return {
      isRunning: false,
      totalMigrated: 0,
      totalArchived: 0,
    };
  }

  async function rollbackMigration(batchId: string): Promise<void> {
    // Placeholder: no-op
  }

  async function verifyMigration(batchId: string): Promise<{ sourceCount: number; targetCount: number; archivedCount: number; matches: boolean; }> {
    return { sourceCount: 0, targetCount: 0, archivedCount: 0, matches: true };
  }

  return {
    migrateLegacyWorkProducts,
    getMigrationStatus,
    rollbackMigration,
    verifyMigration,
  };
}
