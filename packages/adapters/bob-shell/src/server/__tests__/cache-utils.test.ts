/**
 * Tests for cache management utilities
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as cacheUtils from "../cache-utils.js";

const {
  listCachedBundles,
  getCacheStats,
  cleanOldBundles,
  cleanExceptRecent,
  cleanAllBundles,
  formatBytes,
  formatCacheStats,
} = cacheUtils;

// Mock environment variables to use temp directory
const mockInstanceDir = join(tmpdir(), `bob-cache-test-${Date.now()}`);

beforeEach(() => {
  process.env.PAPERCLIP_HOME = mockInstanceDir;
  process.env.PAPERCLIP_INSTANCE_ID = "test";
});

describe("Cache Utils", () => {
  const testCompanyId = "test-company-123";
  const cacheDir = join(mockInstanceDir, "instances", "test", "companies", testCompanyId, "bob-prompt-cache");

  beforeEach(async () => {
    // Clean up before each test
    await rm(mockInstanceDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up after each test
    await rm(mockInstanceDir, { recursive: true, force: true });
  });

  describe("listCachedBundles", () => {
    it("should return empty array when cache is empty", async () => {
      const bundles = await listCachedBundles(testCompanyId);
      expect(bundles).toEqual([]);
    });

    it("should return empty array when cache directory does not exist", async () => {
      await rm(cacheDir, { recursive: true, force: true });
      const bundles = await listCachedBundles(testCompanyId);
      expect(bundles).toEqual([]);
    });

    it("should list all cached bundles", async () => {
      // Create test bundles
      const bundle1 = join(cacheDir, "bundle-abc123");
      const bundle2 = join(cacheDir, "bundle-def456");
      
      await mkdir(bundle1);
      await mkdir(bundle2);
      
      await writeFile(join(bundle1, "system.txt"), "system prompt");
      await writeFile(join(bundle1, "skills.txt"), "skill content");
      await writeFile(join(bundle2, "system.txt"), "system prompt 2");
      
      const bundles = await listCachedBundles(testCompanyId);
      
      expect(bundles).toHaveLength(2);
      expect(bundles.map(b => b.bundleKey).sort()).toEqual([
        "bundle-abc123",
        "bundle-def456",
      ]);
      
      // Check bundle details
      const bundle1Entry = bundles.find(b => b.bundleKey === "bundle-abc123");
      expect(bundle1Entry).toBeDefined();
      expect(bundle1Entry!.fileCount).toBe(2);
      expect(bundle1Entry!.sizeBytes).toBeGreaterThan(0);
    });

    it("should sort bundles by last accessed time (most recent first)", async () => {
      // Create bundles with different access times
      const bundle1 = join(cacheDir, "bundle-old");
      const bundle2 = join(cacheDir, "bundle-new");
      
      await mkdir(bundle1);
      await mkdir(bundle2);
      
      await writeFile(join(bundle1, "file.txt"), "content");
      await writeFile(join(bundle2, "file.txt"), "content");
      
      // Set different access times
      const oldTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
      const newTime = new Date(); // Now
      
      await utimes(bundle1, oldTime, oldTime);
      await utimes(bundle2, newTime, newTime);
      
      const bundles = await listCachedBundles(testCompanyId);
      
      expect(bundles[0]!.bundleKey).toBe("bundle-new");
      expect(bundles[1]!.bundleKey).toBe("bundle-old");
    });

    it("should handle empty bundle directories", async () => {
      const bundle = join(cacheDir, "bundle-empty");
      await mkdir(bundle);
      
      const bundles = await listCachedBundles(testCompanyId);
      
      expect(bundles).toHaveLength(1);
      expect(bundles[0].fileCount).toBe(0);
      expect(bundles[0].sizeBytes).toBe(0);
    });
  });

  describe("getCacheStats", () => {
    it("should return zero stats when cache is empty", async () => {
      const stats = await getCacheStats(testCompanyId);
      
      expect(stats).toEqual({
        totalBundles: 0,
        totalSizeBytes: 0,
        totalFiles: 0,
        oldestBundle: null,
        newestBundle: null,
        averageSizeBytes: 0,
      });
    });

    it("should calculate correct statistics", async () => {
      // Create test bundles
      const bundle1 = join(cacheDir, "bundle-1");
      const bundle2 = join(cacheDir, "bundle-2");
      
      await mkdir(bundle1);
      await mkdir(bundle2);
      
      await writeFile(join(bundle1, "file1.txt"), "a".repeat(100));
      await writeFile(join(bundle1, "file2.txt"), "b".repeat(200));
      await writeFile(join(bundle2, "file3.txt"), "c".repeat(300));
      
      const stats = await getCacheStats(testCompanyId);
      
      expect(stats.totalBundles).toBe(2);
      expect(stats.totalFiles).toBe(3);
      expect(stats.totalSizeBytes).toBe(600);
      expect(stats.averageSizeBytes).toBe(300);
      expect(stats.oldestBundle).toBeInstanceOf(Date);
      expect(stats.newestBundle).toBeInstanceOf(Date);
    });
  });

  describe("cleanOldBundles", () => {
    it("should delete bundles older than specified days", async () => {
      // Create bundles with different ages
      const oldBundle = join(cacheDir, "bundle-old");
      const newBundle = join(cacheDir, "bundle-new");
      
      await mkdir(oldBundle);
      await mkdir(newBundle);
      
      await writeFile(join(oldBundle, "file.txt"), "content");
      await writeFile(join(newBundle, "file.txt"), "content");
      
      // Set access times
      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      const newTime = new Date(); // Now
      
      await utimes(oldBundle, oldTime, oldTime);
      await utimes(newBundle, newTime, newTime);
      
      // Clean bundles older than 7 days
      const deletedCount = await cleanOldBundles(testCompanyId, 7);
      
      expect(deletedCount).toBe(1);
      
      const remainingBundles = await listCachedBundles(testCompanyId);
      expect(remainingBundles).toHaveLength(1);
      expect(remainingBundles[0].bundleKey).toBe("bundle-new");
    });

    it("should not delete bundles within age limit", async () => {
      const bundle = join(cacheDir, "bundle-recent");
      await mkdir(bundle);
      await writeFile(join(bundle, "file.txt"), "content");
      
      const deletedCount = await cleanOldBundles(testCompanyId, 7);
      
      expect(deletedCount).toBe(0);
      
      const bundles = await listCachedBundles(testCompanyId);
      expect(bundles).toHaveLength(1);
    });

    it("should return 0 when cache is empty", async () => {
      const deletedCount = await cleanOldBundles(testCompanyId, 7);
      expect(deletedCount).toBe(0);
    });
  });

  describe("cleanExceptRecent", () => {
    it("should keep only N most recent bundles", async () => {
      // Create 5 bundles
      for (let i = 0; i < 5; i++) {
        const bundle = join(cacheDir, `bundle-${i}`);
        await mkdir(bundle);
        await writeFile(join(bundle, "file.txt"), "content");
        
        // Set different access times
        const time = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        await utimes(bundle, time, time);
      }
      
      // Keep only 2 most recent
      const deletedCount = await cleanExceptRecent(testCompanyId, 2);
      
      expect(deletedCount).toBe(3);
      
      const remainingBundles = await listCachedBundles(testCompanyId);
      expect(remainingBundles).toHaveLength(2);
      expect(remainingBundles.map((b) => b.bundleKey).sort()).toEqual([
        "bundle-0",
        "bundle-1",
      ]);
    });

    it("should not delete anything if count is greater than bundles", async () => {
      const bundle = join(cacheDir, "bundle-1");
      await mkdir(bundle);
      await writeFile(join(bundle, "file.txt"), "content");
      
      const deletedCount = await cleanExceptRecent(testCompanyId, 5);
      
      expect(deletedCount).toBe(0);
      
      const bundles = await listCachedBundles(testCompanyId);
      expect(bundles).toHaveLength(1);
    });

    it("should return 0 when cache is empty", async () => {
      const deletedCount = await cleanExceptRecent(testCompanyId, 2);
      expect(deletedCount).toBe(0);
    });
  });

  describe("cleanAllBundles", () => {
    it("should delete all bundles", async () => {
      // Create multiple bundles
      for (let i = 0; i < 3; i++) {
        const bundle = join(cacheDir, `bundle-${i}`);
        await mkdir(bundle);
        await writeFile(join(bundle, "file.txt"), "content");
      }
      
      const deletedCount = await cleanAllBundles(testCompanyId);
      
      expect(deletedCount).toBe(3);
      
      const bundles = await listCachedBundles(testCompanyId);
      expect(bundles).toHaveLength(0);
    });

    it("should return 0 when cache is empty", async () => {
      const deletedCount = await cleanAllBundles(testCompanyId);
      expect(deletedCount).toBe(0);
    });
  });

  describe("formatBytes", () => {
    it("should format bytes correctly", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(100)).toBe("100.00 B");
      expect(formatBytes(1024)).toBe("1.00 KB");
      expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
      expect(formatBytes(1536)).toBe("1.50 KB");
    });
  });

  describe("formatCacheStats", () => {
    it("should format empty cache stats", () => {
      const stats = {
        totalBundles: 0,
        totalSizeBytes: 0,
        totalFiles: 0,
        oldestBundle: null,
        newestBundle: null,
        averageSizeBytes: 0,
      };
      
      expect(formatCacheStats(stats)).toBe("Cache is empty");
    });

    it("should format cache stats with data", () => {
      const stats = {
        totalBundles: 5,
        totalSizeBytes: 1024 * 1024 * 10, // 10 MB
        totalFiles: 25,
        oldestBundle: new Date("2026-04-01T00:00:00Z"),
        newestBundle: new Date("2026-04-29T00:00:00Z"),
        averageSizeBytes: 1024 * 1024 * 2, // 2 MB
      };
      
      const formatted = formatCacheStats(stats);
      
      expect(formatted).toContain("Total bundles: 5");
      expect(formatted).toContain("Total size: 10.00 MB");
      expect(formatted).toContain("Total files: 25");
      expect(formatted).toContain("Average bundle size: 2.00 MB");
      expect(formatted).toContain("Oldest bundle: 2026-04-01T00:00:00.000Z");
      expect(formatted).toContain("Newest bundle: 2026-04-29T00:00:00.000Z");
    });
  });
});
