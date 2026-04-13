import { useEffect, useState, useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { CLIENT_STATUSES } from "@paperclipai/shared";
import { clientsApi } from "../api/clients";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { clientUrl } from "../lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Users, Plus, Search } from "lucide-react";

const PAGE_SIZE = 50;

export function Clients() {
  const { selectedCompanyId } = useCompany();
  const { openNewClient } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: "Clients" }]);
  }, [setBreadcrumbs]);

  const isFiltering = searchQuery.trim() !== "" || statusFilter !== "all";

  const { data: response, isLoading, error } = useQuery({
    queryKey: [...queryKeys.clients.list(selectedCompanyId!), isFiltering ? "all" : offset],
    queryFn: () =>
      clientsApi.list(selectedCompanyId!, isFiltering ? undefined : { limit: PAGE_SIZE, offset }),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });

  const clients = response?.data ?? [];
  const total = response?.total ?? 0;

  const filteredClients = useMemo(() => {
    let result = clients;
    if (statusFilter !== "all") {
      result = result.filter((c) => c.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q) ||
          c.contactName?.toLowerCase().includes(q),
      );
    }
    return result;
  }, [clients, searchQuery, statusFilter]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="Select a company to view clients." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const hasClients = total > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {hasClients && (
          <>
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search clients..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {CLIENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Button size="sm" variant="outline" onClick={openNewClient} className="shrink-0 ml-auto">
          <Plus className="h-4 w-4 mr-1" />
          Add Client
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!hasClients && (
        <EmptyState
          icon={Users}
          message="No clients yet."
          action="Add Client"
          onAction={openNewClient}
        />
      )}

      {hasClients && filteredClients.length === 0 && (
        <EmptyState
          icon={Search}
          message="No clients match your filters."
        />
      )}

      {filteredClients.length > 0 && (
        <div className="border border-border rounded-lg">
          {filteredClients.map((client) => (
            <EntityRow
              key={client.id}
              title={client.name}
              subtitle={
                [
                  client.contactName ? `Primary contact: ${client.contactName}` : null,
                  client.email,
                  client.linkedProjectCount != null ? `${client.linkedProjectCount} linked projects` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
              to={clientUrl(client)}
              trailing={
                <div className="flex items-center gap-3">
                  {client.activeProjectCount != null ? (
                    <span className="text-xs text-muted-foreground">
                      {client.activeProjectCount} active
                    </span>
                  ) : null}
                  <StatusBadge status={client.status} />
                </div>
              }
            />
          ))}
        </div>
      )}

      {!isFiltering && offset + PAGE_SIZE < total && (
        <Button variant="outline" className="w-full" onClick={() => setOffset((o) => o + PAGE_SIZE)}>
          Load more ({total - offset - PAGE_SIZE} remaining)
        </Button>
      )}

      {!isFiltering && offset > 0 && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>
            Back to first page
          </Button>
        </div>
      )}
    </div>
  );
}
