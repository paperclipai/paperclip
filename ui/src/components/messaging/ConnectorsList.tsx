import React, { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader, Trash2, AlertCircle, MessageSquare } from "lucide-react";

interface Connector {
  id: string;
  platform: string;
  name: string;
  status: "active" | "inactive" | "error";
  errorMessage?: string;
  createdAt: string;
}

interface ConnectorsListProps {
  companyId: string;
}

export function ConnectorsList({ companyId }: ConnectorsListProps) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchConnectors();
  }, [companyId]);

  const fetchConnectors = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/companies/${companyId}/messaging/connectors`);
      if (!response.ok) throw new Error("Failed to fetch connectors");
      const data = await response.json();
      setConnectors(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load connectors");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (connectorId: string) => {
    if (!confirm("Are you sure you want to delete this connector?")) return;

    try {
      setDeletingId(connectorId);
      const response = await fetch(
        `/api/companies/${companyId}/messaging/connectors/${connectorId}`,
        { method: "DELETE" }
      );
      if (!response.ok) throw new Error("Failed to delete connector");
      setConnectors(connectors.filter((c) => c.id !== connectorId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete connector");
    } finally {
      setDeletingId(null);
    }
  };

  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      case "telegram":
        return "📱";
      case "whatsapp":
        return "💬";
      case "slack":
        return "🔷";
      case "email":
        return "📧";
      default:
        return "💬";
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-100 text-green-800";
      case "inactive":
        return "bg-gray-100 text-gray-800";
      case "error":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader className="w-6 h-6 animate-spin text-gray-400" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{error}</span>
        </CardContent>
      </Card>
    );
  }

  if (connectors.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connected Platforms</CardTitle>
          <CardDescription>No messaging connectors yet. Set up your first one to get started.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8 text-gray-500">
            <MessageSquare className="w-12 h-12 opacity-20" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected Platforms</CardTitle>
        <CardDescription>{connectors.length} connector(s) configured</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {connectors.map((connector) => (
            <div
              key={connector.id}
              className="flex items-start justify-between p-4 border rounded-lg hover:bg-gray-50 transition"
            >
              <div className="flex items-start gap-3 flex-1">
                <span className="text-xl mt-1">{getPlatformIcon(connector.platform)}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{connector.name}</h3>
                    <Badge className={getStatusColor(connector.status)}>
                      {connector.status}
                    </Badge>
                  </div>
                  <p className="text-sm text-gray-500 capitalize">{connector.platform} · Created {new Date(connector.createdAt).toLocaleDateString()}</p>
                  {connector.errorMessage && (
                    <div className="flex items-center gap-1 mt-1 text-sm text-red-600">
                      <AlertCircle className="w-3 h-3" />
                      {connector.errorMessage}
                    </div>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(connector.id)}
                disabled={deletingId === connector.id}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
              >
                {deletingId === connector.id ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
