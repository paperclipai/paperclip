'use client'

import { LayoutDashboard, Wallet, Settings, LogOut, Menu } from 'lucide-react'
import { useState } from 'react'

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="retro-surface flex h-14 items-center justify-between border-b px-6">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="retro-active flex h-8 w-8 items-center justify-center rounded-lg">
            <LayoutDashboard className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold tracking-wide">AgentVault</span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button className="retro-chip relative flex items-center gap-2 px-3 py-1.5 text-sm hover:border-accent/70">
          <Wallet className="h-4 w-4" />
          <span>Wallets</span>
        </button>

        <button className="retro-chip rounded-md p-2 hover:border-accent/70">
          <Settings className="h-4 w-4 text-foreground/80" />
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="retro-chip flex h-9 w-9 items-center justify-center rounded-md hover:border-accent/70"
          >
            <Menu className="h-4 w-4 text-foreground/80" />
          </button>

          {menuOpen && (
            <div className="retro-surface absolute right-0 top-10 z-50 w-56 rounded-lg shadow-lg">
              <div className="p-1">
                <button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-secondary/80">
                  <LogOut className="h-4 w-4 text-foreground/80" />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
