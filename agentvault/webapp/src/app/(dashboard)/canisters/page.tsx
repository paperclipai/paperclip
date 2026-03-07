'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  AlertTriangle,
  BriefcaseBusiness,
  Cable,
  Command,
  Flame,
  HeartOff,
  Mail,
  PawPrint,
  ShieldAlert,
  Truck,
  UserRound,
  Wrench,
} from 'lucide-react'
import clsx from 'clsx'
import { useControlCenter } from '@/hooks/useControlCenter'
import { cloneControlCenterFallback } from '@/lib/control-center-fallback'
import type {
  ControlCenterCrewMember,
  ControlCenterEscalation,
  ControlCenterMergeItem,
  ControlCenterWorkItem,
  ControlCenterWorker,
} from '@/lib/types'

interface PanelProps {
  title: string
  count: number
  icon: LucideIcon
  children: ReactNode
  actionLabel?: string
}

function crewStateTone(state: ControlCenterCrewMember['state']): string {
  switch (state) {
    case 'Ready':
      return 'bg-emerald-500/15 text-emerald-300'
    case 'On Patrol':
      return 'bg-sky-500/15 text-sky-300'
    case 'Repairing':
      return 'bg-amber-500/15 text-amber-300'
    default:
      return 'bg-zinc-500/15 text-zinc-300'
  }
}

function workerStateTone(status: ControlCenterWorker['status']): string {
  switch (status) {
    case 'Running':
      return 'bg-emerald-500/15 text-emerald-300'
    case 'Idle':
      return 'bg-zinc-500/15 text-zinc-300'
    default:
      return 'bg-amber-500/15 text-amber-300'
  }
}

function mergeCiTone(ci: ControlCenterMergeItem['ci']): string {
  switch (ci) {
    case 'Pass':
      return 'bg-lime-500/20 text-lime-300'
    case 'Fail':
      return 'bg-rose-500/20 text-rose-300'
    default:
      return 'bg-amber-500/20 text-amber-300'
  }
}

function escalationTone(severity: ControlCenterEscalation['severity']): string {
  switch (severity) {
    case 'P1':
      return 'bg-rose-500/20 text-rose-300'
    case 'P2':
      return 'bg-orange-500/20 text-orange-300'
    default:
      return 'bg-zinc-500/20 text-zinc-300'
  }
}

function workStatusTone(status: ControlCenterWorkItem['status']): string {
  switch (status) {
    case 'READY':
      return 'bg-emerald-500/20 text-emerald-300'
    case 'IN PROGRESS':
      return 'bg-sky-500/20 text-sky-300'
    default:
      return 'bg-amber-500/20 text-amber-300'
  }
}

function priorityTone(priority: ControlCenterWorkItem['priority']): string {
  switch (priority) {
    case 'P1':
      return 'bg-rose-500/20 text-rose-300'
    case 'P2':
      return 'bg-orange-500/20 text-orange-300'
    default:
      return 'bg-zinc-500/20 text-zinc-300'
  }
}

function Panel({ title, count, icon: Icon, children, actionLabel = 'Expand' }: PanelProps) {
  return (
    <section className="retro-surface overflow-hidden rounded-xl border-cyan-200/25">
      <div className="flex items-center justify-between border-b border-cyan-200/15 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-cyan-200" />
          <h2 className="text-lg font-semibold tracking-wide text-slate-100">{title}</h2>
          <span className="rounded-full bg-slate-500/30 px-2 py-0.5 text-xs text-slate-300">{count}</span>
        </div>
        <button className="retro-chip rounded-md px-2.5 py-1 text-xs text-slate-200/80 hover:border-cyan-200/60">
          {actionLabel}
        </button>
      </div>
      <div className="min-h-[150px] bg-slate-950/15 p-3">{children}</div>
    </section>
  )
}

export default function CanistersPage() {
  const fallback = cloneControlCenterFallback()
  const { data, isLoading, error } = useControlCenter({ refreshSeconds: fallback.stats.autoRefreshSeconds })
  const model = data ?? fallback
  const refreshedAt = new Date(model.updatedAt).toLocaleTimeString()

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-200/10 pb-3">
        <h1 className="text-2xl font-semibold uppercase tracking-[0.2em] text-cyan-200 [text-shadow:0_0_14px_rgba(107,225,255,0.7)] lg:text-4xl">
          {model.title}
        </h1>
        <div className="flex items-center gap-3">
          <button className="retro-chip flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium">
            <Command className="h-4 w-4" />
            Commands
            <span className="rounded bg-slate-600/50 px-1.5 text-xs">⌘K</span>
          </button>
          <p className="text-xs text-muted-foreground">
            Auto-refresh: {model.stats.autoRefreshSeconds}s
          </p>
          <p className="text-xs text-muted-foreground">Updated: {refreshedAt}</p>
        </div>
      </div>

      <section className="retro-surface rounded-xl px-4 py-4">
        <div className="flex items-center gap-3 text-lg">
          <span className="text-xl">🎩</span>
          <span className="font-semibold">{model.mayor.name}</span>
          <span className="rounded-md border border-zinc-400/20 bg-zinc-500/20 px-2 py-0.5 text-xs uppercase tracking-wide text-zinc-300">
            {model.mayor.status}
          </span>
          {isLoading && (
            <span className="rounded bg-cyan-500/15 px-2 py-0.5 text-xs text-cyan-300">syncing</span>
          )}
          {error && (
            <span className="rounded bg-rose-500/15 px-2 py-0.5 text-xs text-rose-300">data fallback</span>
          )}
        </div>
      </section>

      <section className="retro-surface flex flex-wrap items-center gap-5 rounded-xl px-4 py-3">
        <div
          className={clsx(
            'flex items-center gap-2 rounded-md px-3 py-2',
            model.stats.heartbeat ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
          )}
        >
          <HeartOff className="h-4 w-4" />
          <span className="text-sm">{model.stats.heartbeat ? 'heartbeat nominal' : 'no heartbeat'}</span>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-cyan-200" />
            <span className="text-2xl font-semibold">{model.stats.workers}</span>
            <span className="text-sm text-muted-foreground">Workers</span>
          </div>
          <div className="flex items-center gap-2">
            <Cable className="h-4 w-4 text-cyan-200" />
            <span className="text-2xl font-semibold">{model.stats.hooks}</span>
            <span className="text-sm text-muted-foreground">Hooks</span>
          </div>
          <div className="flex items-center gap-2">
            <BriefcaseBusiness className="h-4 w-4 text-cyan-200" />
            <span className="text-2xl font-semibold">{model.stats.work}</span>
            <span className="text-sm text-muted-foreground">Work</span>
          </div>
          <div className="flex items-center gap-2">
            <Truck className="h-4 w-4 text-cyan-200" />
            <span className="text-2xl font-semibold">{model.stats.convoys}</span>
            <span className="text-sm text-muted-foreground">Convoys</span>
          </div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-cyan-200" />
            <span className="text-2xl font-semibold">{model.stats.escalations}</span>
            <span className="text-sm text-muted-foreground">Escalations</span>
          </div>
        </div>

        <div className="ml-auto">
          <span className="inline-flex items-center gap-2 rounded-full bg-rose-500/20 px-3 py-1 text-sm font-semibold text-rose-300">
            <Flame className="h-4 w-4" />
            {model.stats.p1p2} P1/P2
          </span>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Convoys" count={model.convoys.length} icon={Truck}>
          <div className="space-y-2 text-sm">
            {model.convoys.map((convoy) => (
              <div key={convoy.id} className="rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-cyan-200">{convoy.id}</span>
                  <span className="text-xs text-muted-foreground">{convoy.eta}</span>
                </div>
                <p className="text-xs text-slate-300/90">{convoy.route}</p>
                <p className="text-xs text-muted-foreground">
                  {convoy.cargo} · {convoy.status}
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Crew" count={model.crew.length} icon={UserRound}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Rig</th>
                  <th className="pb-2">State</th>
                  <th className="pb-2">Hook</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cyan-200/10">
                {model.crew.map((member) => (
                  <tr key={member.name}>
                    <td className="py-2 font-semibold text-cyan-200">{member.name}</td>
                    <td className="py-2">{member.rig}</td>
                    <td className="py-2">
                      <span className={clsx('rounded px-2 py-0.5 text-xs', crewStateTone(member.state))}>
                        {member.state}
                      </span>
                    </td>
                    <td className="py-2 text-muted-foreground">{member.hook}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Workers" count={model.workers.length} icon={Wrench}>
          <div className="space-y-2 text-sm">
            {model.workers.map((worker) => (
              <div key={worker.name} className="flex items-center justify-between rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <div>
                  <p className="font-medium">{worker.name}</p>
                  <p className="text-xs text-muted-foreground">{worker.role}</p>
                </div>
                <div className="text-right">
                  <span className={clsx('rounded px-2 py-0.5 text-xs', workerStateTone(worker.status))}>
                    {worker.status}
                  </span>
                  <p className="text-xs text-muted-foreground">{worker.uptime}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Sessions" count={model.sessions.length} icon={ShieldAlert}>
          <div className="space-y-2 text-sm">
            {model.sessions.map((session) => (
              <div key={session.id} className="rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-cyan-200">{session.id}</span>
                  <span className="text-xs text-muted-foreground">{session.lastSeen}</span>
                </div>
                <p className="text-xs text-slate-300/90">
                  {session.owner} · {session.state}
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Activity" count={model.activity.length} icon={BriefcaseBusiness}>
          <div className="space-y-2 text-sm">
            {model.activity.map((entry) => (
              <div key={entry.id} className="rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <p className="text-slate-100">{entry.message}</p>
                <p className="text-xs text-muted-foreground">{entry.age}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Mail" count={model.inbox.length} icon={Mail}>
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="rounded bg-sky-500/20 px-2 py-1 text-sky-300">Inbox</span>
            <span className="rounded bg-slate-500/20 px-2 py-1 text-slate-300">All Traffic</span>
          </div>
          <div className="space-y-2 text-sm">
            {model.inbox.map((mail) => (
              <div key={mail.id} className="rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-cyan-200">{mail.from}</span>
                  <span className="text-xs text-muted-foreground">{mail.age}</span>
                </div>
                <p className="text-xs text-slate-300/90">{mail.subject}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Merge Queue" count={model.mergeQueue.length} icon={Cable}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2">PR</th>
                  <th className="pb-2">Repo</th>
                  <th className="pb-2">Title</th>
                  <th className="pb-2">CI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cyan-200/10">
                {model.mergeQueue.map((item) => (
                  <tr key={item.pr}>
                    <td className="py-2 font-semibold text-cyan-200">{item.pr}</td>
                    <td className="py-2">{item.repo}</td>
                    <td className="max-w-[200px] py-2 truncate text-slate-300">{item.title}</td>
                    <td className="py-2">
                      <span className={clsx('rounded px-2 py-0.5 text-xs font-medium', mergeCiTone(item.ci))}>
                        {item.ci}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Escalations" count={model.escalations.length} icon={AlertTriangle}>
          <div className="space-y-2 text-sm">
            {model.escalations.map((item) => (
              <div key={item.id} className="rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className={clsx('rounded px-2 py-0.5 text-xs font-medium', escalationTone(item.severity))}>
                    {item.severity}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.owner}</span>
                </div>
                <p className="mt-1 text-xs text-slate-200">{item.title}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Rigs" count={model.rigs.length} icon={Truck}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Polecats</th>
                  <th className="pb-2">Crew</th>
                  <th className="pb-2">Agents</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cyan-200/10">
                {model.rigs.map((rig) => (
                  <tr key={rig.name}>
                    <td className="py-2 font-semibold text-cyan-200">{rig.name}</td>
                    <td className="py-2">{rig.polecats}</td>
                    <td className="py-2">{rig.crew}</td>
                    <td className="py-2">{rig.agents}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Dogs" count={model.dogs.length} icon={PawPrint}>
          <div className="space-y-2 text-sm">
            {model.dogs.map((dog) => (
              <div key={dog.name} className="rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-cyan-200">{dog.name}</span>
                  <span className="text-xs text-muted-foreground">{dog.status}</span>
                </div>
                <p className="text-xs text-slate-300/90">Handler: {dog.handler}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Work" count={model.workItems.length} icon={BriefcaseBusiness} actionLabel="+ New">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="rounded bg-emerald-500/20 px-2 py-1 text-emerald-300">Ready</span>
            <span className="rounded bg-slate-500/20 px-2 py-1 text-slate-300">In Progress</span>
            <span className="rounded bg-slate-500/20 px-2 py-1 text-slate-300">All</span>
          </div>
          <div className="space-y-2 text-sm">
            {model.workItems.map((item) => (
              <div key={item.id} className="rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={clsx('rounded px-2 py-0.5 text-xs font-medium', priorityTone(item.priority))}>
                    {item.priority}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.age}</span>
                </div>
                <p className="mt-1 font-medium text-cyan-200">{item.id}</p>
                <p className="truncate text-xs text-slate-300/90">{item.title}</p>
                <span className={clsx('mt-1 inline-flex rounded px-2 py-0.5 text-xs font-medium', workStatusTone(item.status))}>
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Hooks" count={model.hooks.length} icon={Cable}>
          <div className="space-y-2 text-sm">
            {model.hooks.map((hook) => (
              <div key={hook.name} className="rounded-md border border-cyan-200/10 bg-slate-950/30 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-cyan-200">{hook.name}</span>
                  <span
                    className={clsx(
                      'rounded px-2 py-0.5 text-xs',
                      hook.status === 'Bound' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-500/20 text-zinc-300'
                    )}
                  >
                    {hook.status}
                  </span>
                </div>
                <p className="text-xs text-slate-300/90">{hook.target}</p>
                <p className="text-xs text-muted-foreground">Last run: {hook.lastRun}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}
