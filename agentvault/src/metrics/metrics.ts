/**
 * Metrics Module
 *
 * Stores and retrieves canister metrics (cycles, memory, messages, etc.)
 * in JSONL format: ~/.agentvault/metrics/<canister-id>/YYYY-MM-DD.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type MetricName = 'cycles_balance' | 'memory_heap' | 'message_count' | 'request_count' | 'error_count';

export interface MetricDataPoint {
  timestamp: Date;
  value: number;
}

export interface MetricTimeSeries {
  metric: MetricName;
  dataPoints: MetricDataPoint[];
}

export interface MetricsSummary {
  canisterId: string;
  metrics: Record<MetricName, {
    current: number;
    min: number;
    max: number;
    avg: number;
    delta?: number;
  }>;
  period: { start: Date; end: Date };
}

export interface CollectorConfig {
  interval?: number;
  retentionDays?: number;
}

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const METRICS_DIR = path.join(AGENTVAULT_DIR, 'metrics');

function getMetricsDir(canisterId: string): string {
  const dir = path.join(METRICS_DIR, canisterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getMetricsFile(canisterId: string, date: Date): string {
  const metricsDir = getMetricsDir(canisterId);
  const dateStr = date.toISOString().split('T')[0];
  return path.join(metricsDir, `${dateStr}.jsonl`);
}

export function storeMetrics(canisterId: string, metrics: Record<MetricName, number>): void {
  const now = new Date();
  const metricsFile = getMetricsFile(canisterId, now);
  
  for (const [metric, value] of Object.entries(metrics) as [MetricName, number][]) {
    const line = JSON.stringify({
      timestamp: now.toISOString(),
      metric,
      value,
    });
    fs.appendFileSync(metricsFile, `${line}\n`);
  }
}

export function getTimeSeries(
  canisterId: string,
  metric: MetricName,
  from: Date,
  to: Date,
): MetricTimeSeries {
  const dataPoints: MetricDataPoint[] = [];
  const currentDate = new Date(from);
  
  while (currentDate <= to) {
    const metricsFile = getMetricsFile(canisterId, currentDate);
    if (fs.existsSync(metricsFile)) {
      const lines = fs.readFileSync(metricsFile, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (line) {
          const parsed = JSON.parse(line);
          if (parsed.metric === metric) {
            const timestamp = new Date(parsed.timestamp);
            if (timestamp >= from && timestamp <= to) {
              dataPoints.push({ timestamp, value: parsed.value });
            }
          }
        }
      }
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  dataPoints.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  
  return { metric, dataPoints };
}

export function getSummary(canisterId: string, days: number = 7): MetricsSummary {
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - days);
  
  const metricValues: Partial<Record<MetricName, number[]>> = {};
  const metricCurrent: Partial<Record<MetricName, number>> = {};
  
  for (const metric of ['cycles_balance', 'memory_heap', 'message_count', 'request_count', 'error_count'] as MetricName[]) {
    const series = getTimeSeries(canisterId, metric, from, now);
    if (series.dataPoints.length > 0) {
      metricValues[metric] = series.dataPoints.map(dp => dp.value);
      const lastPoint = series.dataPoints[series.dataPoints.length - 1];
      if (lastPoint) {
        metricCurrent[metric] = lastPoint.value;
      }
    }
  }
  
  const summary: MetricsSummary = {
    canisterId,
    metrics: {} as Record<MetricName, { current: number; min: number; max: number; avg: number; delta?: number }>,
    period: { start: from, end: now },
  };
  
  for (const [metric, values] of Object.entries(metricValues)) {
    if (values) {
      const currentValue = metricCurrent[metric as MetricName];
      if (currentValue !== undefined) {
        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        
        summary.metrics[metric as MetricName] = {
          current: currentValue,
          min,
          max,
          avg,
        };
      }
    }
  }
  
  return summary;
}

export function pruneOldData(canisterId: string, retentionDays: number): void {
  const metricsDir = getMetricsDir(canisterId);
  if (!fs.existsSync(metricsDir)) return;
  
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  
  const files = fs.readdirSync(metricsDir);
  for (const file of files) {
    if (file.endsWith('.jsonl')) {
      const dateStr = file.replace('.jsonl', '');
      const fileDate = new Date(dateStr);
      if (fileDate < cutoff) {
        fs.unlinkSync(path.join(metricsDir, file));
      }
    }
  }
}

export function startCollector(
  canisterId: string,
  config: CollectorConfig = {},
): NodeJS.Timeout {
  const { interval = 60000, retentionDays = 7 } = config;
  
  const collect = async () => {
    try {
      pruneOldData(canisterId, retentionDays);
    } catch (error) {
      console.error(`Failed to collect metrics for ${canisterId}:`, error);
    }
  };
  
  collect();
  return setInterval(collect, interval);
}
