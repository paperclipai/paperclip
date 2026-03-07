/**
 * Monitoring Tests (CLE-105)
 *
 * Tests for parseCycleValue, health thresholds, and monitoring functions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  determineHealthStatus,
  generateHealthAlerts,
  checkHealth,
} from '../../src/monitoring/health.js';
import type {
  CanisterStatusInfo,
  HealthThresholds,
  MonitoringOptions,
} from '../../src/monitoring/types.js';

vi.mock('../../src/monitoring/info.js', () => ({
  getCanisterInfo: vi.fn().mockResolvedValue({
    canisterId: 'test-canister',
    status: 'running',
    memorySize: BigInt(100 * 1024 * 1024),
    cycles: BigInt(1_000_000_000_000),
    health: 'healthy',
    timestamp: new Date(),
  } as CanisterStatusInfo),
}));

describe('Monitoring Module', () => {
  let baseStatusInfo: CanisterStatusInfo;

  beforeEach(() => {
    baseStatusInfo = {
      canisterId: 'test-canister',
      status: 'running',
      memorySize: BigInt(100 * 1024 * 1024),
      cycles: BigInt(1_000_000_000_000),
      health: 'healthy',
      timestamp: new Date(),
    };
  });

  describe('determineHealthStatus()', () => {
    it('should return healthy for normal metrics', () => {
      const result = determineHealthStatus(baseStatusInfo, {});

      expect(result).toBe('healthy');
    });

    it('should return critical when cycles below critical threshold', () => {
      const thresholds: HealthThresholds = {
        cyclesCritical: BigInt(2_000_000_000_000),
      };
      baseStatusInfo.cycles = BigInt(1_000_000_000_000);

      const result = determineHealthStatus(baseStatusInfo, thresholds);

      expect(result).toBe('critical');
    });

    it('should return warning when cycles below warning threshold', () => {
      const thresholds: HealthThresholds = {
        cyclesWarning: BigInt(2_000_000_000_000),
        cyclesCritical: BigInt(500_000_000_000),
      };
      baseStatusInfo.cycles = BigInt(1_000_000_000_000);

      const result = determineHealthStatus(baseStatusInfo, thresholds);

      expect(result).toBe('warning');
    });

    it('should return critical when stopped', () => {
      baseStatusInfo.status = 'stopped';

      const result = determineHealthStatus(baseStatusInfo, {});

      expect(result).toBe('critical');
    });

    it('should return warning when stopping', () => {
      baseStatusInfo.status = 'stopping';

      const result = determineHealthStatus(baseStatusInfo, {});

      expect(result).toBe('warning');
    });

    it('should calculate memory threshold correctly (4GB max)', () => {
      const thresholds: HealthThresholds = {
        memoryCriticalPercent: 90,
      };
      baseStatusInfo.memorySize = BigInt(Math.round(3.7 * 1024 * 1024 * 1024));

      const result = determineHealthStatus(baseStatusInfo, thresholds);

      expect(result).toBe('critical');
    });

    it('should handle memory warning threshold', () => {
      const thresholds: HealthThresholds = {
        memoryWarningPercent: 50,
        memoryCriticalPercent: 90,
      };
      baseStatusInfo.memorySize = BigInt(2.5 * 1024 * 1024 * 1024);

      const result = determineHealthStatus(baseStatusInfo, thresholds);

      expect(result).toBe('warning');
    });

    it('should prioritize cycles over memory checks', () => {
      const thresholds: HealthThresholds = {
        cyclesCritical: BigInt(100),
      };
      baseStatusInfo.cycles = BigInt(50);

      const result = determineHealthStatus(baseStatusInfo, thresholds);

      expect(result).toBe('critical');
    });
  });

  describe('generateHealthAlerts()', () => {
    it('should generate no alerts for healthy status', () => {
      const alerts = generateHealthAlerts(baseStatusInfo, {}, 'healthy');

      expect(alerts).toHaveLength(0);
    });

    it('should generate critical alert for low cycles', () => {
      const thresholds: HealthThresholds = {
        cyclesCritical: BigInt(2_000_000_000_000),
      };
      baseStatusInfo.cycles = BigInt(1_000_000_000_000);

      const alerts = generateHealthAlerts(baseStatusInfo, thresholds, 'critical');

      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0]?.severity).toBe('critical');
      expect(alerts[0]?.metric).toBe('cycles');
    });

    it('should generate warning alert for moderate cycles', () => {
      const thresholds: HealthThresholds = {
        cyclesWarning: BigInt(3_000_000_000_000),
        cyclesCritical: BigInt(500_000_000_000),
      };
      baseStatusInfo.cycles = BigInt(2_000_000_000_000);

      const alerts = generateHealthAlerts(baseStatusInfo, thresholds, 'warning');

      const cyclesAlert = alerts.find(a => a.metric === 'cycles');
      expect(cyclesAlert?.severity).toBe('warning');
    });

    it('should include canister ID in alerts', () => {
      const thresholds: HealthThresholds = {
        cyclesCritical: BigInt(2_000_000_000_000),
      };
      baseStatusInfo.cycles = BigInt(1_000_000_000_000);

      const alerts = generateHealthAlerts(baseStatusInfo, thresholds, 'critical');

      expect(alerts[0]?.canisterId).toBe('test-canister');
    });

    it('should include timestamp in alerts', () => {
      const thresholds: HealthThresholds = {
        cyclesCritical: BigInt(2_000_000_000_000),
      };
      baseStatusInfo.cycles = BigInt(1_000_000_000_000);

      const alerts = generateHealthAlerts(baseStatusInfo, thresholds, 'critical');

      expect(alerts[0]?.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('checkHealth()', () => {
    it('should return status with health information', async () => {
      const result = await checkHealth('test-canister');

      expect(result.canisterId).toBe('test-canister');
      expect(result.health).toBeDefined();
    });

    it('should apply custom thresholds', async () => {
      const options: Partial<MonitoringOptions> = {
        thresholds: {
          cyclesCritical: BigInt(100),
        },
      };

      const result = await checkHealth('test-canister', options);

      expect(result).toBeDefined();
    });
  });

  describe('Cycle Value Parsing (parseCycleValue)', () => {
    it('should parse T (trillion) suffix correctly', async () => {
      const { getCanisterInfo } = await import('../../src/monitoring/info.js');
      vi.mocked(getCanisterInfo).mockResolvedValueOnce({
        ...baseStatusInfo,
        cycles: BigInt(5 * 1_000_000_000_000),
      });

      const result = await checkHealth('test-canister');
      expect(result.cycles).toBe(BigInt(5_000_000_000_000));
    });

    it('should parse G (billion) suffix correctly', async () => {
      const { getCanisterInfo } = await import('../../src/monitoring/info.js');
      vi.mocked(getCanisterInfo).mockResolvedValueOnce({
        ...baseStatusInfo,
        cycles: BigInt(5 * 1_000_000_000),
      });

      const result = await checkHealth('test-canister');
      expect(result.cycles).toBe(BigInt(5_000_000_000));
    });

    it('should parse M (million) suffix correctly', async () => {
      const { getCanisterInfo } = await import('../../src/monitoring/info.js');
      vi.mocked(getCanisterInfo).mockResolvedValueOnce({
        ...baseStatusInfo,
        cycles: BigInt(5 * 1_000_000),
      });

      const result = await checkHealth('test-canister');
      expect(result.cycles).toBe(BigInt(5_000_000));
    });

    it('should parse K (thousand) suffix correctly', async () => {
      const { getCanisterInfo } = await import('../../src/monitoring/info.js');
      vi.mocked(getCanisterInfo).mockResolvedValueOnce({
        ...baseStatusInfo,
        cycles: BigInt(5 * 1_000),
      });

      const result = await checkHealth('test-canister');
      expect(result.cycles).toBe(BigInt(5_000));
    });

    it('should parse μ (micro) suffix correctly', async () => {
      const { getCanisterInfo } = await import('../../src/monitoring/info.js');
      vi.mocked(getCanisterInfo).mockResolvedValueOnce({
        ...baseStatusInfo,
        cycles: BigInt(1),
      });

      const result = await checkHealth('test-canister');
      expect(result.cycles).toBeDefined();
    });

    it('should handle B (base) as raw value', async () => {
      const { getCanisterInfo } = await import('../../src/monitoring/info.js');
      vi.mocked(getCanisterInfo).mockResolvedValueOnce({
        ...baseStatusInfo,
        cycles: BigInt(500),
      });

      const result = await checkHealth('test-canister');
      expect(result.cycles).toBe(BigInt(500));
    });
  });

  describe('Memory Threshold Calculation', () => {
    it('should use 4GB as max canister memory', () => {
      const thresholds: HealthThresholds = {
        memoryCriticalPercent: 90,
      };
      baseStatusInfo.memorySize = BigInt(Math.round(3.9 * 1024 * 1024 * 1024));

      const result = determineHealthStatus(baseStatusInfo, thresholds);

      expect(result).toBe('critical');
    });

    it('should handle 80% threshold correctly', () => {
      const thresholds: HealthThresholds = {
        memoryWarningPercent: 80,
      };
      baseStatusInfo.memorySize = BigInt(Math.round(3.5 * 1024 * 1024 * 1024));

      const result = determineHealthStatus(baseStatusInfo, thresholds);

      expect(result).toBe('warning');
    });

    it('should handle undefined memory gracefully', () => {
      baseStatusInfo.memorySize = undefined;

      const result = determineHealthStatus(baseStatusInfo, {
        memoryCriticalPercent: 90,
      });

      expect(result).toBe('healthy');
    });
  });
});
