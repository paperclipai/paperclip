import { useState } from "react";
import { cn } from "@/lib/utils";
import { Routines } from "./Routines";
import { WorkflowList } from "./WorkflowList";

type Tab = "routines" | "workflows";

export function Workflows() {
  const [activeTab, setActiveTab] = useState<Tab>("routines");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Automation</h1>
      </div>

      <div className="mb-6 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {(["routines", "workflows"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn("relative px-4 py-2 pb-3 text-[13px] capitalize")}
            style={{ color: activeTab === tab ? "var(--fg)" : "var(--fg-muted)", fontWeight: activeTab === tab ? 500 : 400, background: "none", border: "none", fontFamily: "var(--font-body)" }}
          >
            {tab}
            {activeTab === tab && <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t" style={{ background: "var(--accent)" }} />}
          </button>
        ))}
      </div>

      {activeTab === "routines" && <Routines />}
      {activeTab === "workflows" && <WorkflowList />}
    </div>
  );
}
