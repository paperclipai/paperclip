'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Activity, Database, Settings, Server, Archive, Wallet, Layers, ShieldCheck } from 'lucide-react'
import clsx from 'clsx'

interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { label: 'Canisters', href: '/canisters', icon: Server },
  { label: 'Agents', href: '/agents', icon: Activity },
  { label: 'Tasks', href: '/tasks', icon: Layers },
  { label: 'Logs', href: '/logs', icon: Database },
  { label: 'Networks', href: '/networks', icon: LayoutDashboard },
  { label: 'Wallets', href: '/wallets', icon: Wallet },
  { label: 'Backups', href: '/backups', icon: Archive },
  { label: 'Proof', href: '/vault', icon: ShieldCheck },
]

const bottomNavItems: NavItem[] = [
  { label: 'Settings', href: '/settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="retro-surface flex h-full w-64 flex-col border-r">
      <div className="flex items-center gap-2 border-b px-6 py-4">
        <div className="retro-active flex h-8 w-8 items-center justify-center rounded-lg">
          <LayoutDashboard className="h-5 w-5 text-primary-foreground" />
        </div>
        <span className="text-lg font-bold tracking-wide">AgentVault</span>
      </div>

      <nav className="flex-1 space-y-1 p-4">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname?.startsWith(item.href)

          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all',
                isActive
                  ? 'retro-active'
                  : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground hover:shadow-[0_0_12px_rgba(107,225,255,0.22)]'
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <nav className="border-t p-4">
        {bottomNavItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname?.startsWith(item.href)

          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all',
                isActive
                  ? 'retro-active'
                  : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground hover:shadow-[0_0_12px_rgba(107,225,255,0.22)]'
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
