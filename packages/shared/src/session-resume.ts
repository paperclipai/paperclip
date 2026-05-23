export interface Task {
  id: string;
  file: string;
  line: number;
  content: string;
  priority: 'high' | 'medium' | 'low';
  type: 'todo' | 'fixme' | 'hack' | 'bug';
}

export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  timestamp: Date;
}

export interface SessionResume {
  sessionId: string;
  branch: string;
  lastActive: Date;
  duration: number;
  unfinishedTasks: Task[];
  recentChanges: FileChange[];
  filesToReopen: string[];
  summary: string;
  contextScore: number;
}

export interface WorkSession {
  id: string;
  companyId: string;
  agentId?: string;
  status: 'active' | 'paused' | 'ended';
  startTime: Date;
  endTime?: Date;
  duration?: number;
  gitBranch?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionSnapshot {
  id: string;
  sessionId: string;
  timestamp: Date;
  gitBranch?: string;
  openFiles?: string[];
  unfinishedTasks?: Task[];
  recentChanges?: FileChange[];
  summary?: string;
  contextScore?: number;
  createdAt: Date;
}
