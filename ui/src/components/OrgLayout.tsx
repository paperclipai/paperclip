import { Outlet } from "@/lib/router";
import { CompanyRail } from "./CompanyRail";
import { OrgSidebar } from "./OrgSidebar";
import { ToastViewport } from "./ToastViewport";

export function OrgLayout() {
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground pt-[env(safe-area-inset-top)]">
      <div className="flex flex-col shrink-0 h-full">
        <div className="flex flex-1 min-h-0">
          <CompanyRail />
          <div className="w-60 overflow-hidden">
            <OrgSidebar />
          </div>
        </div>
      </div>
      
      <div className="flex min-w-0 flex-col h-full flex-1">
        <div className="flex flex-1 min-h-0">
          <main className="flex-1 p-4 md:p-6 overflow-auto bg-muted/20">
            <Outlet />
          </main>
        </div>
      </div>
      <ToastViewport />
    </div>
  );
}
