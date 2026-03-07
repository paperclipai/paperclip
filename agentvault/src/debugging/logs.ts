/**
 * Log aggregation for canister debugging
 *
 * Collects, stores, and queries logs from canisters
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LogEntry, LogLevel } from './types.js';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const LOGS_DIR = path.join(AGENTVAULT_DIR, 'logs');

/**
 * Ensure logs directory exists
 */
function ensureLogsDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Get logs directory for a specific canister
 */
function getCanisterLogsDir(canisterId: string): string {
  ensureLogsDir();
  const canisterDir = path.join(LOGS_DIR, canisterId);
  if (!fs.existsSync(canisterDir)) {
    fs.mkdirSync(canisterDir, { recursive: true });
  }
  return canisterDir;
}

/**
 * Get log file path for a canister and date
 */
function getLogFilePath(canisterId: string, date?: Date): string {
  const logsDir = getCanisterLogsDir(canisterId);
  const logDate = date || new Date();
  const dateStr = logDate.toISOString().split('T')[0];
  return path.join(logsDir, `${dateStr}.jsonl`);
}

/**
 * Parse log line from canister output
 */
function parseLogLine(line: string, canisterId: string): LogEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    
    return {
      timestamp: new Date(parsed.timestamp as string),
      level: (parsed.level as LogLevel) || 'info',
      message: (parsed.message as string) || '',
      canisterId,
      method: parsed.method as string | undefined,
      context: parsed.context as Record<string, unknown> | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Collect logs from canister output
 */
export async function collectLogs(canisterId: string, output: string): Promise<LogEntry[]> {
  const logs: LogEntry[] = [];
  const lines = output.split('\n');
  
  for (const line of lines) {
    if (line.trim()) {
      const logEntry = parseLogLine(line, canisterId);
      if (logEntry) {
        logs.push(logEntry);
      }
    }
  }
  
  return logs;
}

/**
 * Store log entries to disk
 */
export async function storeLogs(canisterId: string, logs: LogEntry[]): Promise<void> {
  const logFilePath = getLogFilePath(canisterId);
  const lines = logs.map((log) => JSON.stringify(log)).join('\n');
  
  fs.appendFileSync(logFilePath, lines + '\n', 'utf8');
}

/**
 * Retrieve logs for a canister with optional filtering
 */
export async function getLogs(
  canisterId: string,
  options: {
    since?: Date;
    level?: LogLevel;
    pattern?: string;
    limit?: number;
  } = {},
): Promise<LogEntry[]> {
  const logsDir = getCanisterLogsDir(canisterId);
  const files = fs.readdirSync(logsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse();
  
  const allLogs: LogEntry[] = [];
  
  for (const file of files) {
    const filePath = path.join(logsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      if (line.trim()) {
        const log = parseLogLine(line, canisterId);
        if (log) {
          allLogs.push(log);
        }
      }
    }
    
    if (options.since) {
      const fileDate = new Date(file.replace('.jsonl', ''));
      if (fileDate < options.since) {
        break;
      }
    }
  }
  
  const filteredLogs = allLogs.filter((log) => {
    if (options.since && log.timestamp < options.since) {
      return false;
    }
    if (options.level && log.level !== options.level) {
      return false;
    }
    if (options.pattern && !log.message.includes(options.pattern)) {
      return false;
    }
    return true;
  });
  
  if (options.limit) {
    return filteredLogs.slice(-options.limit);
  }
  
  return filteredLogs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * Export logs to a file
 */
export async function exportLogs(
  canisterId: string,
  outputPath: string,
  format: 'json' | 'csv' = 'json',
): Promise<void> {
  const logs = await getLogs(canisterId);
  
  if (format === 'json') {
    fs.writeFileSync(outputPath, JSON.stringify(logs, null, 2), 'utf8');
  } else if (format === 'csv') {
    const headers = 'timestamp,level,message,canisterId,method,context\n';
    const rows = logs.map((log) => {
      const context = log.context ? JSON.stringify(log.context).replace(/"/g, '""') : '';
      return `"${log.timestamp.toISOString()}","${log.level}","${log.message.replace(/"/g, '""')}","${log.canisterId}","${log.method || ''}","${context}"`;
    }).join('\n');
    
    fs.writeFileSync(outputPath, headers + rows, 'utf8');
  }
}

/**
 * Clear logs for a canister
 */
export async function clearLogs(canisterId: string): Promise<void> {
  const logsDir = getCanisterLogsDir(canisterId);
  const files = fs.readdirSync(logsDir);
  
  for (const file of files) {
    fs.unlinkSync(path.join(logsDir, file));
  }
}
