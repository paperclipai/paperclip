import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Network } from "lucide-react";

export function OrgDashboard() {
  const { companies } = useCompany();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto py-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Organisation Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">Overview of all active teams.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Teams</CardTitle>
            <Network className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{companies.length}</div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4 mt-4">
        <h2 className="text-lg font-semibold tracking-tight">Active Teams</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {companies.map(company => (
            <Card 
              key={company.id} 
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => navigate(`/${company.issuePrefix}/dashboard`)}
            >
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <div 
                    className="w-3 h-3 rounded-sm shadow-sm ring-1 ring-border/50" 
                    style={{ backgroundColor: company.brandColor || "#ccc" }} 
                  />
                  {company.name}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {company.description || "No description provided."}
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <span className="text-xs font-medium bg-muted px-2 py-0.5 rounded text-muted-foreground">
                    {company.issuePrefix}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
