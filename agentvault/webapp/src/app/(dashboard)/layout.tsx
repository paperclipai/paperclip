import { Header } from '@/components/layout/Header'
import { Sidebar } from '@/components/layout/Sidebar'

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(80,205,255,0.09),_transparent_48%),linear-gradient(180deg,_rgba(8,4,22,0.8),_rgba(6,3,16,0.9))]">
          {children}
        </main>
      </div>
    </div>
  )
}
