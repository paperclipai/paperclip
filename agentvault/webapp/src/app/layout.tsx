import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '../providers/ThemeProvider'
import { ICProvider } from '../providers/ICProvider'

export const metadata: Metadata = {
  title: 'AgentVault - AI Agent Platform',
  description: 'Manage persistent AI agents on the Internet Computer',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ThemeProvider>
          <ICProvider>
            <div className="min-h-screen bg-background text-foreground">
              {children}
            </div>
          </ICProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
