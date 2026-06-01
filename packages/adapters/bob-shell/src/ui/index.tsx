import React from "react";

interface BobShellConfigProps {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}

export function BobShellConfig({ value, onChange }: BobShellConfigProps) {
  const config = value || {};

  const handleChange = (key: string, val: unknown) => {
    onChange({ ...config, [key]: val });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          Command
          <span className="text-gray-500 ml-2">(optional, defaults to "bob")</span>
        </label>
        <input
          type="text"
          value={(config.command as string) || ""}
          onChange={(e) => handleChange("command", e.target.value)}
          placeholder="bob"
          className="w-full px-3 py-2 border rounded"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Mode
          <span className="text-gray-500 ml-2">(optional, defaults to "paperclip-agent")</span>
        </label>
        <input
          type="text"
          value={(config.mode as string) || ""}
          onChange={(e) => handleChange("mode", e.target.value)}
          placeholder="paperclip-agent"
          className="w-full px-3 py-2 border rounded"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Working Directory
          <span className="text-gray-500 ml-2">(optional, absolute path)</span>
        </label>
        <input
          type="text"
          value={(config.cwd as string) || ""}
          onChange={(e) => handleChange("cwd", e.target.value)}
          placeholder="/path/to/workspace"
          className="w-full px-3 py-2 border rounded"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Timeout (seconds)
          <span className="text-gray-500 ml-2">(0 for no timeout)</span>
        </label>
        <input
          type="number"
          value={(config.timeoutSec as number) || 0}
          onChange={(e) => handleChange("timeoutSec", parseInt(e.target.value) || 0)}
          placeholder="0"
          min="0"
          className="w-full px-3 py-2 border rounded"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Grace Period (seconds)
          <span className="text-gray-500 ml-2">(SIGTERM grace before SIGKILL)</span>
        </label>
        <input
          type="number"
          value={(config.graceSec as number) || 20}
          onChange={(e) => handleChange("graceSec", parseInt(e.target.value) || 20)}
          placeholder="20"
          min="0"
          className="w-full px-3 py-2 border rounded"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Extra Arguments
          <span className="text-gray-500 ml-2">(comma-separated)</span>
        </label>
        <input
          type="text"
          value={
            Array.isArray(config.extraArgs)
              ? (config.extraArgs as string[]).join(", ")
              : ""
          }
          onChange={(e) =>
            handleChange(
              "extraArgs",
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            )
          }
          placeholder="--verbose, --debug"
          className="w-full px-3 py-2 border rounded"
        />
      </div>

      <div className="pt-4 border-t">
        <p className="text-sm text-gray-600">
          <strong>Note:</strong> Bob Shell must be installed and available in PATH.
          Paperclip will generate <code>.bob/</code> workspace configuration before
          launching Bob Shell.
        </p>
      </div>
    </div>
  );
}
