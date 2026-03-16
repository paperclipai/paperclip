import React, { useState, useEffect } from "react";
import { Search, FileText, AlertCircle, Loader } from "lucide-react";

interface Document {
  id: string;
  name: string;
  contentType: string;
  status: "processing" | "ready" | "error";
  chunkCount?: number;
  createdAt: string;
}

interface KnowledgeBrowserProps {
  companyId: string;
  onSelectDocument?: (doc: Document) => void;
}

export const KnowledgeBrowser: React.FC<KnowledgeBrowserProps> = ({
  companyId,
  onSelectDocument,
}) => {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [filteredDocs, setFilteredDocs] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    fetchDocuments();
  }, [companyId]);

  useEffect(() => {
    if (searchQuery.trim()) {
      searchDocuments();
    } else {
      setFilteredDocs(documents);
    }
  }, [searchQuery, documents]);

  const fetchDocuments = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch(
        `/api/companies/${companyId}/knowledge/documents`
      );
      if (!response.ok) {
        throw new Error("Failed to fetch documents");
      }
      const data = await response.json();
      setDocuments(data.documents || []);
      setFilteredDocs(data.documents || []);
    } catch (err: any) {
      setError(err.message || "Failed to load documents");
    } finally {
      setIsLoading(false);
    }
  };

  const searchDocuments = async () => {
    if (!searchQuery.trim()) {
      setFilteredDocs(documents);
      return;
    }

    try {
      const response = await fetch(
        `/api/companies/${companyId}/knowledge/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: searchQuery,
            limit: 20,
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Search failed");
      }

      const data = await response.json();
      setFilteredDocs(data.results || []);
    } catch (err: any) {
      setError(err.message || "Search failed");
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "ready":
        return "text-green-600 bg-green-50";
      case "processing":
        return "text-amber-600 bg-amber-50";
      case "error":
        return "text-red-600 bg-red-50";
      default:
        return "text-gray-600 bg-gray-50";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "ready":
        return "Ready";
      case "processing":
        return "Processing...";
      case "error":
        return "Error";
      default:
        return status;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader className="w-6 h-6 text-gray-400 animate-spin" />
        <p className="ml-2 text-gray-500">Loading documents...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search documents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Error Message */}
      {error && (
        <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {/* Document List */}
      {filteredDocs.length > 0 ? (
        <div className="space-y-2">
          {filteredDocs.map((doc) => (
            <button
              key={doc.id}
              onClick={() => onSelectDocument?.(doc)}
              className="w-full text-left p-4 border border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors group"
            >
              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-gray-400 mt-1 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-600">
                    {doc.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {doc.contentType} • {doc.chunkCount || 0} chunks
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(doc.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div
                  className={`px-2 py-1 rounded text-xs font-medium flex-shrink-0 ${getStatusColor(
                    doc.status
                  )}`}
                >
                  {getStatusLabel(doc.status)}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <FileText className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 text-sm">
            {searchQuery
              ? "No documents match your search"
              : "No documents uploaded yet"}
          </p>
          {!searchQuery && (
            <p className="text-gray-400 text-xs mt-1">
              Upload documents to get started
            </p>
          )}
        </div>
      )}

      {/* Document Count */}
      {filteredDocs.length > 0 && (
        <div className="text-xs text-gray-500 text-center pt-4">
          Showing {filteredDocs.length} of {documents.length} documents
        </div>
      )}
    </div>
  );
};
