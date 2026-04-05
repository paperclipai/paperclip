import { useState } from "react";
import { Card, Button, Avatar, Chip, Tabs } from "@heroui/react";
import { Bot, CircleDot, DollarSign, ShieldCheck, Activity, Inbox, FolderOpen, Target, Boxes, CheckCircle } from "lucide-react";
import { motion } from "framer-motion";

// ── Shared mock data ───────────────────────────────────────────────────────

const metrics = [
  { icon: Bot, value: "167", label: "Agents Enabled", sub: "0 running", accent: true, color: "primary" },
  { icon: CircleDot, value: "0", label: "In Progress", sub: "2 open", accent: false, color: "default" },
  { icon: DollarSign, value: "$0", label: "Month Spend", sub: "Unlimited", accent: false, color: "success" },
  { icon: ShieldCheck, value: "0", label: "Approvals", sub: "All clear", accent: false, color: "default" },
];

const activityItems = [
  { action: "commented on", target: "AGE-2" },
  { action: "created", target: "AGE-2" },
  { action: "invoked heartbeat for", target: "CEO" },
];

const tasks = [
  { id: "AGE-2", title: "What do I need to do for you?", agent: "CEO" },
  { id: "AGE-1", title: "Create strategy for Verakon", agent: "CEO" },
];

// ── Sidebar Nav Item helper ────────────────────────────────────────────────

function NavItem({ icon: Icon, label, active, badge, activeClass }: {
  icon: typeof Bot; label: string; active?: boolean; badge?: number; activeClass: string;
}) {
  return (
    <button className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium w-full transition-colors ${
      active ? activeClass : 'text-foreground/40 hover:bg-default/40'
    }`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">{label}</span>
      {badge != null && badge > 0 && (
        <span className="bg-danger text-white text-[10px] px-1.5 py-0.5 rounded-full font-semibold">{badge}</span>
      )}
    </button>
  );
}

// ── Direction A: Glass & Gradient ──────────────────────────────────────────

function DirectionA() {
  const activeNav = "bg-gradient-to-r from-accent/15 to-accent/5 border border-accent/10 text-accent";
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">A) Glass & Gradient</h2>
        <p className="text-sm text-foreground/50 mt-1">Frosted glass surfaces, backdrop blur, gradient accents. Apple Vision Pro / macOS Sonoma.</p>
      </div>

      <div className="flex rounded-2xl overflow-hidden border border-white/[0.06] shadow-2xl h-[520px]">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 bg-white/[0.03] backdrop-blur-xl border-r border-white/[0.06] flex flex-col p-3 gap-1">
          <div className="flex items-center gap-2.5 px-2 py-2 mb-2">
            <Avatar size="sm" className="bg-gradient-to-br from-accent to-secondary shrink-0">
              <Avatar.Fallback className="text-white font-bold text-xs border-none bg-transparent">A</Avatar.Fallback>
            </Avatar>
            <span className="text-sm font-semibold text-foreground/90">Agency Agents</span>
          </div>

          <div className="mx-1 mb-2 flex items-center gap-2 rounded-xl bg-white/[0.04] border border-white/[0.06] px-3 py-2 text-xs text-foreground/30">
            Search... <kbd className="ml-auto rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-mono">⌘K</kbd>
          </div>

          <div className="px-1 mb-1 text-[10px] uppercase tracking-wider text-foreground/20 font-medium">Overview</div>
          <NavItem icon={Activity} label="Dashboard" active activeClass={activeNav} />
          <NavItem icon={Activity} label="Activity" activeClass={activeNav} />
          <NavItem icon={Inbox} label="Inbox" badge={2} activeClass={activeNav} />
          <div className="px-1 mt-3 mb-1 text-[10px] uppercase tracking-wider text-foreground/20 font-medium">Work</div>
          <NavItem icon={CircleDot} label="Issues" activeClass={activeNav} />
          <NavItem icon={FolderOpen} label="Projects" activeClass={activeNav} />
          <NavItem icon={Target} label="Goals" activeClass={activeNav} />
          <div className="px-1 mt-3 mb-1 text-[10px] uppercase tracking-wider text-foreground/20 font-medium">Team</div>
          <NavItem icon={Bot} label="Agents" activeClass={activeNav} />
        </aside>

        {/* Main */}
        <div className="flex-1 p-6 overflow-auto bg-background/80 backdrop-blur-sm">
          <h1 className="text-2xl font-bold tracking-tight mb-6">Dashboard</h1>
          <div className="grid grid-cols-4 gap-3 mb-6">
            {metrics.map((m, i) => (
              <Card key={i} className={`${m.accent ? 'bg-gradient-to-br from-accent/[0.08] to-accent/[0.02] border-accent/10' : 'bg-white/[0.03] border-white/[0.06]'} backdrop-blur-md`}>
                <Card.Content className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className={`text-3xl font-extrabold tracking-tight ${m.accent ? 'bg-gradient-to-r from-accent to-secondary bg-clip-text text-transparent' : 'text-foreground'}`}>
                        {m.value}
                      </div>
                      <div className="text-xs text-foreground/40 mt-1 font-medium">{m.label}</div>
                      <div className={`text-[10px] mt-0.5 ${m.accent ? 'text-accent/50' : 'text-foreground/25'}`}>{m.sub}</div>
                    </div>
                    <m.icon className={`h-5 w-5 ${m.accent ? 'text-accent/40' : 'text-foreground/15'}`} />
                  </div>
                </Card.Content>
              </Card>
            ))}
          </div>

          <Card className="bg-white/[0.03] border-white/[0.06] backdrop-blur-md">
            <Card.Header className="px-4 py-3 border-b border-white/[0.04]">
              <Card.Title className="text-sm font-semibold text-foreground/60">Recent Activity</Card.Title>
            </Card.Header>
            <Card.Content className="p-0">
              {activityItems.map((item, i) => (
                <div key={i} className="px-4 py-3 border-b border-white/[0.03] last:border-0 text-sm flex justify-between items-center">
                  <span className="text-foreground/50">Board {item.action} <span className="text-accent font-medium">{item.target}</span></span>
                  <span className="text-xs text-foreground/20">5d ago</span>
                </div>
              ))}
            </Card.Content>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Direction B: Solid & Confident ─────────────────────────────────────────

function DirectionB() {
  const activeNav = "bg-accent text-accent-foreground font-semibold";
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">B) Solid & Confident</h2>
        <p className="text-sm text-foreground/50 mt-1">Elevated cards, clear borders/shadows, bold accent on active nav. Linear / Arc Browser.</p>
      </div>

      <div className="flex rounded-2xl overflow-hidden border border-default-200 shadow-2xl h-[520px]">
        <aside className="w-56 shrink-0 bg-surface border-r border-default-200 flex flex-col p-3 gap-1">
          <div className="flex items-center gap-2.5 px-2 py-2 mb-2">
            <Avatar size="sm" color="accent">
              <Avatar.Fallback className="font-bold text-xs">A</Avatar.Fallback>
            </Avatar>
            <span className="text-sm font-semibold">Agency Agents</span>
          </div>

          <div className="mx-1 mb-2 flex items-center gap-2 rounded-xl bg-default/40 border border-default-200 px-3 py-2 text-xs text-foreground/30">
            Search... <kbd className="ml-auto rounded border border-default-200 bg-background px-1.5 py-0.5 text-[10px] font-mono">⌘K</kbd>
          </div>

          <div className="px-1 mb-1 text-[10px] uppercase tracking-wider text-foreground/25 font-medium">Overview</div>
          <NavItem icon={Activity} label="Dashboard" active activeClass={activeNav} />
          <NavItem icon={Activity} label="Activity" activeClass={activeNav} />
          <NavItem icon={Inbox} label="Inbox" badge={2} activeClass={activeNav} />
          <div className="px-1 mt-3 mb-1 text-[10px] uppercase tracking-wider text-foreground/25 font-medium">Work</div>
          <NavItem icon={CircleDot} label="Issues" activeClass={activeNav} />
          <NavItem icon={FolderOpen} label="Projects" activeClass={activeNav} />
          <NavItem icon={Target} label="Goals" activeClass={activeNav} />
          <div className="px-1 mt-3 mb-1 text-[10px] uppercase tracking-wider text-foreground/25 font-medium">Team</div>
          <NavItem icon={Bot} label="Agents" activeClass={activeNav} />
        </aside>

        <div className="flex-1 p-6 overflow-auto bg-background">
          <h1 className="text-2xl font-bold tracking-tight mb-6">Dashboard</h1>
          <div className="grid grid-cols-4 gap-3 mb-6">
            {metrics.map((m, i) => (
              <Card key={i} className="border-default-200/60">
                <Card.Content className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className={`text-3xl font-extrabold tracking-tight ${i === 0 ? 'text-accent' : 'text-foreground'}`}>{m.value}</div>
                      <div className="text-xs text-foreground/40 mt-1 font-medium">{m.label}</div>
                      <div className="text-[10px] text-foreground/25 mt-0.5">{m.sub}</div>
                    </div>
                    <div className="rounded-xl bg-default/50 p-2">
                      <m.icon className="h-4 w-4 text-foreground/30" />
                    </div>
                  </div>
                </Card.Content>
              </Card>
            ))}
          </div>

          <Card className="border-default-200/60">
            <Card.Header className="px-4 py-3 border-b border-default-200/60">
              <Card.Title className="text-sm font-semibold text-foreground/60">Recent Activity</Card.Title>
            </Card.Header>
            <Card.Content className="p-0">
              {activityItems.map((item, i) => (
                <div key={i} className="px-4 py-3 border-b border-default-200/40 last:border-0 text-sm flex justify-between items-center">
                  <span className="text-foreground/50">Board {item.action} <span className="text-accent font-medium">{item.target}</span></span>
                  <span className="text-xs text-foreground/20">5d ago</span>
                </div>
              ))}
            </Card.Content>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Direction C: Luminous Accent ───────────────────────────────────────────

function DirectionC() {
  const activeNav = "bg-gradient-to-r from-accent/15 to-accent/5 border border-accent/10 text-accent font-semibold";
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-bold tracking-tight">C) Luminous Accent</h2>
        <Chip size="sm" color="accent" variant="soft">Recommended</Chip>
      </div>
      <p className="text-sm text-foreground/50">Hybrid — solid cards with accent-tinted gradients on key elements. Apple + Linear.</p>

      <div className="flex rounded-2xl overflow-hidden shadow-2xl h-[520px]" style={{ border: '1px solid color-mix(in srgb, var(--color-accent) 8%, transparent)', boxShadow: '0 8px 40px rgba(99,102,241,0.06), 0 0 0 1px rgba(99,102,241,0.08)' }}>
        {/* Sidebar */}
        <aside className="w-56 shrink-0 bg-surface/80 backdrop-blur-md flex flex-col p-3 gap-1" style={{ borderRight: '1px solid color-mix(in srgb, var(--color-accent) 6%, transparent)' }}>
          <div className="flex items-center gap-2.5 px-2 py-2 mb-2">
            <Avatar size="sm" className="bg-gradient-to-br from-accent to-secondary shadow-md shadow-accent/20 shrink-0">
              <Avatar.Fallback className="text-white font-bold text-xs border-none bg-transparent">A</Avatar.Fallback>
            </Avatar>
            <span className="text-sm font-semibold text-foreground/90">Agency Agents</span>
          </div>

          <div className="mx-1 mb-2 flex items-center gap-2 rounded-xl bg-default/30 border border-default-200/40 px-3 py-2 text-xs text-foreground/30">
            Search... <kbd className="ml-auto rounded border border-default-200/50 bg-background px-1.5 py-0.5 text-[10px] font-mono text-foreground/25">⌘K</kbd>
          </div>

          <div className="px-1 mb-1 text-[10px] uppercase tracking-wider text-accent/30 font-medium">Overview</div>
          <NavItem icon={Activity} label="Dashboard" active activeClass={activeNav} />
          <NavItem icon={Activity} label="Activity" activeClass={activeNav} />
          <NavItem icon={Inbox} label="Inbox" badge={2} activeClass={activeNav} />
          <div className="px-1 mt-3 mb-1 text-[10px] uppercase tracking-wider text-accent/30 font-medium">Work</div>
          <NavItem icon={CircleDot} label="Issues" activeClass={activeNav} />
          <NavItem icon={FolderOpen} label="Projects" activeClass={activeNav} />
          <NavItem icon={Target} label="Goals" activeClass={activeNav} />
          <div className="px-1 mt-3 mb-1 text-[10px] uppercase tracking-wider text-accent/30 font-medium">Team</div>
          <NavItem icon={Bot} label="Agents" activeClass={activeNav} />
          <NavItem icon={Boxes} label="Skills" activeClass={activeNav} />
          <div className="px-1 mt-3 mb-1 text-[10px] uppercase tracking-wider text-accent/30 font-medium">Operations</div>
          <NavItem icon={CheckCircle} label="Approvals" activeClass={activeNav} />
          <NavItem icon={DollarSign} label="Costs" activeClass={activeNav} />
        </aside>

        {/* Main */}
        <div className="flex-1 p-6 overflow-auto bg-background">
          <h1 className="text-2xl font-bold tracking-tight mb-6">Dashboard</h1>

          {/* Metric cards */}
          <div className="grid grid-cols-4 gap-3 mb-6">
            {metrics.map((m, i) => (
              <Card
                key={i}
                className={
                  m.accent
                    ? 'bg-gradient-to-br from-accent/[0.08] to-accent/[0.02] border-accent/[0.12]'
                    : m.color === 'success'
                    ? 'bg-gradient-to-br from-success/[0.05] to-transparent border-success/[0.08]'
                    : 'border-default-200/60'
                }
                style={m.accent ? { boxShadow: '0 2px 16px rgba(99,102,241,0.06)' } : undefined}
              >
                <Card.Content className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className={`text-3xl font-extrabold tracking-tight ${
                        m.accent ? 'text-accent' : m.color === 'success' ? 'text-success' : 'text-foreground'
                      }`}>{m.value}</div>
                      <div className="text-xs text-foreground/40 mt-1.5 font-medium">{m.label}</div>
                      <div className={`text-[10px] mt-0.5 ${
                        m.accent ? 'text-accent/40' : m.color === 'success' ? 'text-success/40' : 'text-foreground/25'
                      }`}>{m.sub}</div>
                    </div>
                    <div className={`rounded-xl p-2 ${
                      m.accent ? 'bg-accent/10' : m.color === 'success' ? 'bg-success/10' : 'bg-default/40'
                    }`}>
                      <m.icon className={`h-4 w-4 ${
                        m.accent ? 'text-accent/50' : m.color === 'success' ? 'text-success/50' : 'text-foreground/20'
                      }`} />
                    </div>
                  </div>
                </Card.Content>
              </Card>
            ))}
          </div>

          {/* Charts placeholder */}
          <div className="grid grid-cols-4 gap-3 mb-6">
            {["Run Activity", "Issues by Priority", "Issues by Status", "Success Rate"].map((title, i) => (
              <Card key={i} className="border-default-200/60">
                <Card.Content className="p-4">
                  <div className="text-xs font-semibold text-foreground/50">{title}</div>
                  <div className="text-[10px] text-foreground/25 mb-3">Last 14 days</div>
                  <div className="h-16 rounded-lg bg-gradient-to-t from-accent/[0.04] to-transparent flex items-end gap-[2px] px-1">
                    {[20, 30, 10, 50, 40, 60, 35, 45, 25, 55, 70, 45, 30, 50].map((h, j) => (
                      <div key={j} className="flex-1 rounded-t bg-accent/20" style={{ height: `${h}%` }} />
                    ))}
                  </div>
                </Card.Content>
              </Card>
            ))}
          </div>

          {/* Activity + Tasks */}
          <div className="grid grid-cols-2 gap-4">
            <Card className="border-default-200/60">
              <Card.Header className="px-4 py-3 border-b border-default-200/40">
                <Card.Title className="text-sm font-semibold text-foreground/60">Recent Activity</Card.Title>
              </Card.Header>
              <Card.Content className="p-0">
                {activityItems.map((item, i) => (
                  <div key={i} className="px-4 py-3 border-b border-default-200/30 last:border-0 text-sm flex items-center gap-3">
                    <Avatar size="sm" className="h-6 w-6 shrink-0">
                      <Avatar.Fallback className="text-[9px] text-foreground/50">BO</Avatar.Fallback>
                    </Avatar>
                    <span className="text-foreground/50 flex-1 min-w-0 truncate">
                      Board {item.action} <span className="text-accent font-medium">{item.target}</span>
                    </span>
                    <span className="text-xs text-foreground/20 shrink-0">5d ago</span>
                  </div>
                ))}
              </Card.Content>
            </Card>

            <Card className="border-default-200/60">
              <Card.Header className="px-4 py-3 border-b border-default-200/40">
                <Card.Title className="text-sm font-semibold text-foreground/60">Recent Tasks</Card.Title>
              </Card.Header>
              <Card.Content className="p-0">
                {tasks.map((item, i) => (
                  <div key={i} className="px-4 py-3 border-b border-default-200/30 last:border-0 text-sm flex items-center gap-3">
                    <div className="h-4 w-4 rounded-full border-2 border-accent/40 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-foreground/70">{item.title}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs font-mono text-foreground/30">{item.id}</span>
                        <Chip size="sm" variant="soft">{item.agent}</Chip>
                      </div>
                    </div>
                    <span className="text-xs text-foreground/20 shrink-0">5d ago</span>
                  </div>
                ))}
              </Card.Content>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Prototype Page ────────────────────────────────────────────────────

export function VisualPrototype() {
  const [direction, setDirection] = useState<string>("c");

  return (
    <div className="min-h-screen bg-background p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Visual Direction Prototype</h1>
        <p className="text-foreground/50">Using real HeroUI v3 components — Card, Avatar, Badge, Chip, Tabs.</p>
      </div>

      <Tabs selectedKey={direction} onSelectionChange={(key) => setDirection(key as string)}>
        <Tabs.ListContainer>
          <Tabs.List aria-label="Visual directions" className="mb-8">
            <Tabs.Tab id="a">A) Glass & Gradient<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="b">B) Solid & Confident<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="c">C) Luminous Accent<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="a">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            <DirectionA />
          </motion.div>
        </Tabs.Panel>
        <Tabs.Panel id="b">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            <DirectionB />
          </motion.div>
        </Tabs.Panel>
        <Tabs.Panel id="c">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            <DirectionC />
          </motion.div>
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
