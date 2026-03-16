import React, { useState, useEffect } from "react";
import { Download, Star, Search, Loader } from "lucide-react";

interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  version: string;
  isBuiltin: boolean;
  rating: number;
  ratingCount: number;
  downloadCount: number;
  tags?: string[];
}

interface SkillsMarketplaceProps {
  companyId: string;
  agentId?: string;
  onInstall?: (skill: Skill) => void;
}

export const SkillsMarketplace: React.FC<SkillsMarketplaceProps> = ({
  companyId,
  agentId,
  onInstall,
}) => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [filteredSkills, setFilteredSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

  useEffect(() => {
    fetchSkills();
  }, []);

  useEffect(() => {
    filterSkills();
  }, [searchQuery, selectedCategory, skills]);

  const fetchSkills = async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/skills");
      if (!response.ok) throw new Error("Failed to fetch skills");
      const data = await response.json();
      setSkills(data.skills || []);
      setFilteredSkills(data.skills || []);
    } catch (error) {
      console.error("Error fetching skills:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const filterSkills = () => {
    let filtered = skills;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query)
      );
    }

    if (selectedCategory) {
      filtered = filtered.filter((s) => s.category === selectedCategory);
    }

    setFilteredSkills(filtered);
  };

  const handleInstall = async (skill: Skill) => {
    try {
      setInstallingId(skill.id);
      const response = await fetch(
        `/api/companies/${companyId}/skills/install`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skillId: skill.id,
            agentId: agentId || undefined,
          }),
        }
      );

      if (!response.ok) throw new Error("Installation failed");
      onInstall?.(skill);
      alert(`Installed ${skill.name}!`);
    } catch (error) {
      console.error("Error installing skill:", error);
      alert("Failed to install skill");
    } finally {
      setInstallingId(null);
    }
  };

  const categories = Array.from(new Set(skills.map((s) => s.category)));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader className="w-6 h-6 text-blue-600 animate-spin" />
        <p className="ml-2 text-gray-600">Loading skills...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Skills Marketplace</h2>
        <p className="text-gray-600 mt-1">
          Discover and install skills to extend agent capabilities
        </p>
      </div>

      {/* Search and Filter */}
      <div className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-2 flex-wrap">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() =>
                setSelectedCategory(
                  selectedCategory === category ? null : category
                )
              }
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                selectedCategory === category
                  ? "bg-blue-600 text-white"
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      {/* Skills Grid */}
      {filteredSkills.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredSkills.map((skill) => (
            <div
              key={skill.id}
              className="border border-gray-200 rounded-lg p-4 hover:shadow-lg transition-shadow"
            >
              {/* Skill Header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900">{skill.name}</h3>
                  <p className="text-xs text-gray-500 mt-1">
                    {skill.category}
                    {skill.isBuiltin && (
                      <span className="ml-2 inline-block px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
                        Built-in
                      </span>
                    )}
                  </p>
                </div>
                <span className="text-xs font-medium text-gray-600">
                  v{skill.version}
                </span>
              </div>

              {/* Description */}
              <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                {skill.description}
              </p>

              {/* Rating and Stats */}
              <div className="flex items-center gap-4 mb-3 text-sm">
                <div className="flex items-center gap-1">
                  <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                  <span className="font-medium">{skill.rating.toFixed(1)}</span>
                  <span className="text-gray-500">({skill.ratingCount})</span>
                </div>
                <span className="text-gray-500">
                  {skill.downloadCount} downloads
                </span>
              </div>

              {/* Tags */}
              {skill.tags && skill.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {skill.tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag}
                      className="inline-block px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Install Button */}
              <button
                onClick={() => handleInstall(skill)}
                disabled={installingId === skill.id}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 font-medium"
              >
                {installingId === skill.id ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Installing...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Install
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-gray-500">
            {searchQuery || selectedCategory
              ? "No skills found matching your criteria"
              : "No skills available"}
          </p>
        </div>
      )}
    </div>
  );
};
