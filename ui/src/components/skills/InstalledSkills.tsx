import React, { useState, useEffect } from "react";
import { Trash2, Loader } from "lucide-react";

interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  rating: number;
}

interface InstalledSkillsProps {
  companyId: string;
  agentId?: string;
}

export const InstalledSkills: React.FC<InstalledSkillsProps> = ({
  companyId,
  agentId,
}) => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);

  useEffect(() => {
    fetchInstalledSkills();
  }, [companyId, agentId]);

  const fetchInstalledSkills = async () => {
    try {
      setIsLoading(true);
      const url = `/api/companies/${companyId}/skills/installed${
        agentId ? `?agentId=${agentId}` : ""
      }`;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Failed to fetch skills");
      const data = await response.json();
      setSkills(data.skills || []);
    } catch (error) {
      console.error("Error fetching installed skills:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUninstall = async (skillId: string) => {
    if (!confirm("Are you sure you want to uninstall this skill?")) return;

    try {
      setUninstallingId(skillId);
      const url = `/api/companies/${companyId}/skills/${skillId}${
        agentId ? `?agentId=${agentId}` : ""
      }`;
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok) throw new Error("Uninstall failed");

      setSkills(skills.filter((s) => s.id !== skillId));
      alert("Skill uninstalled successfully");
    } catch (error) {
      console.error("Error uninstalling skill:", error);
      alert("Failed to uninstall skill");
    } finally {
      setUninstallingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader className="w-5 h-5 text-blue-600 animate-spin" />
        <p className="ml-2 text-gray-600">Loading installed skills...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-gray-900">Installed Skills</h3>

      {skills.length > 0 ? (
        <div className="space-y-2">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className="flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded-lg"
            >
              <div className="flex-1">
                <p className="font-medium text-gray-900">{skill.name}</p>
                <p className="text-sm text-gray-600">{skill.category}</p>
              </div>
              <button
                onClick={() => handleUninstall(skill.id)}
                disabled={uninstallingId === skill.id}
                className="ml-2 p-2 text-gray-400 hover:text-red-600 disabled:text-gray-300 rounded hover:bg-red-50"
                title="Uninstall skill"
              >
                {uninstallingId === skill.id ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-gray-500 text-sm">No skills installed yet</p>
      )}
    </div>
  );
};
