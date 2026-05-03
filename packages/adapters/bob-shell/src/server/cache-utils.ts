/**
 * Cache management utilities for Bob Shell prompt bundles
 * 
 * Provides tools to inspect, analyze, and clean the prompt bundle cache.
 */

import { readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

/**
 * Get the Paperclip instance directory
 */
function getInstanceDir(): string {
  const paperclipHome = process.env.PAPERCLIP_HOME ?? resolve(homedir(), ".paperclip");
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return resolve(paperclipHome, "instances", instanceId);
}

export interface CacheEntry {
  bundleKey: string;
  path: string;
  sizeBytes: number;
  createdAt: Date;
  lastAccessedAt: Date;
  fileCount: number;
}

export interface CacheStats {
  totalBundles: number;
  totalSizeBytes: number;
  totalFiles: number;
  oldestBundle: Date | null;
  newestBundle: Date | null;
  averageSizeBytes: number;
}

/**
 * Get the cache directory for a company
 */
function getCacheDir(companyId: string): string {
  const instanceDir = getInstanceDir();
  return join(instanceDir, "companies", companyId, "bob-prompt-cache");
}

/**
 * List all cached prompt bundles for a company
 */
export async function listCachedBundles(companyId: string): Promise<CacheEntry[]> {
  const cacheDir = getCacheDir(companyId);
  
  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    const bundles: CacheEntry[] = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const bundlePath = join(cacheDir, entry.name);
      const bundleStat = await stat(bundlePath);
      
      // Count files in bundle
      let fileCount = 0;
      let totalSize = 0;
      
      try {
        const bundleFiles = await readdir(bundlePath);
        fileCount = bundleFiles.length;
        
        // Calculate total size
        for (const file of bundleFiles) {
          const filePath = join(bundlePath, file);
          const fileStat = await stat(filePath);
          if (fileStat.isFile()) {
            totalSize += fileStat.size;
          }
        }
      } catch {
        // Bundle directory might be empty or inaccessible
      }
      
      bundles.push({
        bundleKey: entry.name,
        path: bundlePath,
        sizeBytes: totalSize,
        createdAt: bundleStat.birthtime,
        lastAccessedAt: bundleStat.atime,
        fileCount,
      });
    }
    
    // Sort by last accessed (most recent first)
    bundles.sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());
    
    return bundles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []; // Cache directory doesn't exist yet
    }
    throw error;
  }
}

/**
 * Get cache statistics for a company
 */
export async function getCacheStats(companyId: string): Promise<CacheStats> {
  const bundles = await listCachedBundles(companyId);
  
  if (bundles.length === 0) {
    return {
      totalBundles: 0,
      totalSizeBytes: 0,
      totalFiles: 0,
      oldestBundle: null,
      newestBundle: null,
      averageSizeBytes: 0,
    };
  }
  
  const totalSizeBytes = bundles.reduce((sum, b) => sum + b.sizeBytes, 0);
  const totalFiles = bundles.reduce((sum, b) => sum + b.fileCount, 0);
  const createdDates = bundles.map(b => b.createdAt.getTime());
  
  return {
    totalBundles: bundles.length,
    totalSizeBytes,
    totalFiles,
    oldestBundle: new Date(Math.min(...createdDates)),
    newestBundle: new Date(Math.max(...createdDates)),
    averageSizeBytes: Math.round(totalSizeBytes / bundles.length),
  };
}

/**
 * Clean old bundles that haven't been accessed in the specified number of days
 * 
 * @param companyId - Company ID
 * @param maxAgeDays - Maximum age in days (bundles older than this will be deleted)
 * @returns Number of bundles deleted
 */
export async function cleanOldBundles(
  companyId: string,
  maxAgeDays: number
): Promise<number> {
  const bundles = await listCachedBundles(companyId);
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  
  let deletedCount = 0;
  
  for (const bundle of bundles) {
    if (bundle.lastAccessedAt < cutoffDate) {
      try {
        await rm(bundle.path, { recursive: true, force: true });
        deletedCount++;
      } catch (error) {
        // Log error but continue
        console.error(`Failed to delete bundle ${bundle.bundleKey}:`, error);
      }
    }
  }
  
  return deletedCount;
}

/**
 * Clean all bundles except the N most recently accessed
 * 
 * @param companyId - Company ID
 * @param keepCount - Number of most recent bundles to keep
 * @returns Number of bundles deleted
 */
export async function cleanExceptRecent(
  companyId: string,
  keepCount: number
): Promise<number> {
  const bundles = await listCachedBundles(companyId);
  
  if (bundles.length <= keepCount) {
    return 0; // Nothing to delete
  }
  
  // Bundles are already sorted by last accessed (most recent first)
  const bundlesToDelete = bundles.slice(keepCount);
  
  let deletedCount = 0;
  
  for (const bundle of bundlesToDelete) {
    try {
      await rm(bundle.path, { recursive: true, force: true });
      deletedCount++;
    } catch (error) {
      console.error(`Failed to delete bundle ${bundle.bundleKey}:`, error);
    }
  }
  
  return deletedCount;
}

/**
 * Clean all cached bundles for a company
 * 
 * @param companyId - Company ID
 * @returns Number of bundles deleted
 */
export async function cleanAllBundles(companyId: string): Promise<number> {
  const bundles = await listCachedBundles(companyId);
  
  let deletedCount = 0;
  
  for (const bundle of bundles) {
    try {
      await rm(bundle.path, { recursive: true, force: true });
      deletedCount++;
    } catch (error) {
      console.error(`Failed to delete bundle ${bundle.bundleKey}:`, error);
    }
  }
  
  return deletedCount;
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format cache stats for display
 */
export function formatCacheStats(stats: CacheStats): string {
  if (stats.totalBundles === 0) {
    return "Cache is empty";
  }
  
  const lines = [
    `Total bundles: ${stats.totalBundles}`,
    `Total size: ${formatBytes(stats.totalSizeBytes)}`,
    `Total files: ${stats.totalFiles}`,
    `Average bundle size: ${formatBytes(stats.averageSizeBytes)}`,
    `Oldest bundle: ${stats.oldestBundle?.toISOString() ?? "N/A"}`,
    `Newest bundle: ${stats.newestBundle?.toISOString() ?? "N/A"}`,
  ];
  
  return lines.join("\n");
}
