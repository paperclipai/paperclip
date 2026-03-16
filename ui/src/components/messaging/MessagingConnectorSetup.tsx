import React, { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, CheckCircle, Loader } from "lucide-react";

interface MessagingConnectorSetupProps {
  companyId: string;
  onSuccess?: (connector: any) => void;
}

type Platform = "telegram" | "whatsapp" | "slack" | "email";

interface PlatformConfig {
  [key: string]: unknown;
}

export function MessagingConnectorSetup({ companyId, onSuccess }: MessagingConnectorSetupProps) {
  const [platform, setPlatform] = useState<Platform>("telegram");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<PlatformConfig>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleConfigChange = (key: string, value: string) => {
    setConfig({ ...config, [key]: value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const response = await fetch(`/api/companies/${companyId}/messaging/connectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          name,
          configuration: config,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create connector");
      }

      const connector = await response.json();
      setSuccess(true);
      setName("");
      setConfig({});
      onSuccess?.(connector);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create connector");
    } finally {
      setLoading(false);
    }
  };

  const getConfigFields = () => {
    switch (platform) {
      case "telegram":
        return [
          { key: "botToken", label: "Bot Token", type: "password", required: true },
        ];
      case "whatsapp":
        return [
          { key: "phoneNumberId", label: "Phone Number ID", type: "text", required: true },
          { key: "accessToken", label: "Access Token", type: "password", required: true },
          { key: "businessAccountId", label: "Business Account ID", type: "text", required: true },
        ];
      case "slack":
        return [
          { key: "botToken", label: "Bot Token", type: "password", required: false },
          { key: "webhookUrl", label: "Webhook URL", type: "text", required: false },
        ];
      case "email":
        return [
          { key: "smtpServer", label: "SMTP Server", type: "text", required: true },
          { key: "smtpPort", label: "SMTP Port", type: "number", required: true },
          { key: "senderEmail", label: "Sender Email", type: "email", required: true },
          { key: "senderPassword", label: "Sender Password", type: "password", required: true },
        ];
      default:
        return [];
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup Messaging Connector</CardTitle>
        <CardDescription>Connect your messaging platforms to enable agent communication</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Platform Selection */}
          <div className="space-y-2">
            <Label htmlFor="platform">Platform</Label>
            <Select value={platform} onValueChange={(value) => setPlatform(value as Platform)}>
              <SelectTrigger id="platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="telegram">Telegram</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="slack">Slack</SelectItem>
                <SelectItem value="email">Email</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Connector Name */}
          <div className="space-y-2">
            <Label htmlFor="name">Connector Name</Label>
            <Input
              id="name"
              placeholder="e.g., Support Team Telegram"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          {/* Platform-Specific Configuration */}
          <div className="space-y-4">
            <Label>Configuration</Label>
            {getConfigFields().map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={field.key} className="text-sm">
                  {field.label}
                  {field.required && <span className="text-red-500"> *</span>}
                </Label>
                <Input
                  id={field.key}
                  type={field.type}
                  placeholder={field.label}
                  value={(config[field.key] as string) || ""}
                  onChange={(e) => handleConfigChange(field.key, e.target.value)}
                  required={field.required}
                />
              </div>
            ))}
          </div>

          {/* Error Message */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {/* Success Message */}
          {success && (
            <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm">Connector created successfully!</span>
            </div>
          )}

          {/* Submit Button */}
          <Button type="submit" disabled={loading} className="w-full">
            {loading && <Loader className="w-4 h-4 mr-2 animate-spin" />}
            {loading ? "Creating..." : "Create Connector"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
