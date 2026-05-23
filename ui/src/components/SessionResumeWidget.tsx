import React, { useEffect, useState } from 'react';
import { timeAgo } from '../lib/timeAgo';
import type { SessionResume } from '@paperclipai/shared';

interface SessionResumeWidgetProps {
  companyId: string;
  agentId?: string;
}

export const SessionResumeWidget: React.FC<SessionResumeWidgetProps> = ({
  companyId,
  agentId,
}) => {
  const [resume, setResume] = useState<SessionResume | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchResume = async () => {
      try {
        setLoading(true);
        const params = new URLSearchParams();
        if (agentId) params.append('agentId', agentId);

        const response = await fetch(
          `/api/companies/${companyId}/sessions/resume?${params}`,
          { credentials: 'include' }
        );

        if (response.ok) {
          const data = await response.json();
          setResume(data);
        }
      } catch (error) {
        console.error('Failed to fetch session resume:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchResume();
  }, [companyId, agentId]);

  if (loading || !resume) return null;

  const contextScoreColor = 
    resume.contextScore >= 75 ? 'text-emerald-400' :
    resume.contextScore >= 50 ? 'text-amber-400' :
    'text-red-400';

  const durationMinutes = Math.round(resume.duration / 60);

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4 mb-4 backdrop-blur">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-zinc-100">
          📋 Resume From Last Session
        </h3>
        <span className={`text-sm font-medium ${contextScoreColor}`}>
          {resume.contextScore}% Complete
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-zinc-800/50 rounded p-3 border border-zinc-700">
          <p className="text-xs text-zinc-400 mb-1">Git Branch</p>
          <code className="text-sm font-mono text-cyan-400">{resume.branch}</code>
        </div>

        <div className="bg-zinc-800/50 rounded p-3 border border-zinc-700">
          <p className="text-xs text-zinc-400 mb-1">Last Active</p>
          <p className="text-sm font-medium text-zinc-200">
            {timeAgo(resume.lastActive)}
          </p>
        </div>

        <div className="bg-zinc-800/50 rounded p-3 border border-zinc-700">
          <p className="text-xs text-zinc-400 mb-1">Duration</p>
          <p className="text-sm font-medium text-zinc-200">{durationMinutes} minutes</p>
        </div>

        <div className="bg-zinc-800/50 rounded p-3 border border-zinc-700">
          <p className="text-xs text-zinc-400 mb-1">Files Modified</p>
          <p className="text-sm font-medium text-zinc-200">{resume.recentChanges.length}</p>
        </div>
      </div>

      {resume.unfinishedTasks.length > 0 && (
        <div className="mb-3 bg-amber-950/40 rounded p-3 border border-amber-700/50">
          <p className="text-xs font-semibold text-amber-200 mb-2">
            ⚠️ Unfinished Tasks ({resume.unfinishedTasks.length})
          </p>
          <ul className="space-y-1">
            {resume.unfinishedTasks.slice(0, 3).map((task, idx) => (
              <li key={idx} className="text-xs text-amber-100">
                <span className="font-mono text-amber-300">{task.file}:{task.line}</span>
                {' - '}{task.content.substring(0, 40)}...
              </li>
            ))}
          </ul>
        </div>
      )}

      {resume.summary && (
        <div className="mb-3 bg-zinc-800/50 rounded p-3 border border-zinc-700">
          <p className="text-xs font-semibold text-zinc-300 mb-1">Summary</p>
          <p className="text-sm text-zinc-400">{resume.summary}</p>
        </div>
      )}

      <button
        onClick={() => {
          console.log('Restoring context from session:', resume.sessionId);
        }}
        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-3 rounded text-sm transition"
      >
        ✨ Restore Context
      </button>
    </div>
  );
};
