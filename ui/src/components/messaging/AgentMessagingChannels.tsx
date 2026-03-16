import React, { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader, Trash2, Plus, CheckCircle, AlertCircle } from "lucide-react";

interface Channel {
  id: string;
  connectorId: string;
  agentId: string;
  channelIdentifier: string;
  channelType?: string;
  enabled: boolean;
  createdAt: string;
  connector?: {
    name: string;
    platform: string;
  };
}

interface Connector {
  id: string;
  name: string;
  platform: string;
  status: string;
}

interface AgentMessagingChannelsProps {
  agentId: string;
  companyId: string;
}

export function AgentMessagingChannels({ agentId, companyId }: AgentMessagingChannelsProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [selectedConnector, setSelectedConnector] = useState("");
  const [channelIdentifier, setChannelIdentifier] = useState("");
  const [channelType, setChannelType] = useState("direct");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, [agentId, companyId]);

  const fetchData = async () => {
    try {
      setLoading(true);

      // Fetch channels
      const channelsRes = await fetch(`/api/agents/${agentId}/messaging/channels`);
      if (channelsRes.ok) {
        setChannels(await channelsRes.json());
      }

      // Fetch connectors
      const connectorsRes = await fetch(`/api/companies/${companyId}/messaging/connectors`);
      if (connectorsRes.ok) {
        setConnectors(await connectorsRes.json());
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedConnector || !channelIdentifier) return;

    try {
      setCreating(true);
      const response = await fetch(`/api/agents/${agentId}/messaging/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorId: selectedConnector,
          channelIdentifier,
          channelType,
          metadata: {},
        }),
      });

      if (!response.ok) throw new Error("Failed to create channel");

      const newChannel = await response.json();
      setChannels([...channels, newChannel]);
      setSelectedConnector("");
      setChannelIdentifier("");
      setChannelType("direct");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create channel");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteChannel = async (channelId: string) => {
    if (!confirm("Are you sure you want to delete this channel?")) return;

    try {
      setDeletingId(channelId);
      const response = await fetch(`/api/agents/${agentId}/messaging/channels/${channelId}`, {
        method: "DELETE",
      });

      if (!response.ok) throw new Error("Failed to delete channel");
      setChannels(channels.filter((c) => c.id !== channelId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete channel");
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

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader className="w-6 h-6 animate-spin text-gray-400" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Create Channel Form */}
      {connectors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="w-5 h-5" />
              Add Messaging Channel
            </CardTitle>
            <CardDescription>Connect this agent to a messaging platform channel</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreateChannel} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="connector">Connector</Label>
                  <Select value={selectedConnector} onValueChange={setSelectedConnector}>
                    <SelectTrigger id="connector">
                      <SelectValue placeholder="Select a connector..." />
                    </SelectTrigger>
                    <SelectContent>
                      {connectors.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {getPlatformIcon(c.platform)} {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="channelIdentifier">Channel Identifier</Label>
                  <Input
                    id="channelIdentifier"
                    placeholder="e.g., chat_id, channel_name, email@example.com"
                    value={channelIdentifier}
                    onChange={(e) => setChannelIdentifier(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="channelType">Channel Type</Label>
                  <Select value={channelType} onValueChange={setChannelType}>
                    <SelectTrigger id="channelType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="direct">Direct Message</SelectItem>
                      <SelectItem value="group">Group</SelectItem>
                      <SelectItem value="channel">Channel</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-end">
                  <Button type="submit" disabled={creating || !selectedConnector || !channelIdentifier} className="w-full">
                    {creating && <Loader className="w-4 h-4 mr-2 animate-spin" />}
                    {creating ? "Adding..." : "Add Channel"}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Channels List */}
      <Card>
        <CardHeader>
          <CardTitle>Connected Channels</CardTitle>
          <CardDescription>
            {channels.length === 0
              ? "No channels connected yet"
              : `${channels.length} channel(s) configured`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {channels.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <p>No messaging channels configured for this agent</p>
            </div>
          ) : (
            <div className="space-y-3">
              {channels.map((channel) => (
                <div key={channel.id} className="flex items-start justify-between p-3 border rounded-lg hover:bg-gray-50 transition">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">
                        {getPlatformIcon(channel.connector?.platform || "unknown")}
                      </span>
                      <div>
                        <p className="font-medium">{channel.channelIdentifier}</p>
                        <p className="text-sm text-gray-500">
                          {channel.connector?.name} · {channel.channelType || "direct"}
                        </p>
                      </div>
                      {channel.enabled && (
                        <Badge className="bg-green-100 text-green-800">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          Active
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteChannel(channel.id)}
                    disabled={deletingId === channel.id}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  >
                    {deletingId === channel.id ? (
                      <Loader className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
