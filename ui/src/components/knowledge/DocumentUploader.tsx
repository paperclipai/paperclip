import React, { useState } from "react";
import { Upload, X, AlertCircle } from "lucide-react";

interface Document {
  id: string;
  name: string;
  contentType: string;
  fileSize?: number;
  status: "processing" | "ready" | "error";
  errorMessage?: string;
  chunkCount?: number;
  createdAt: string;
}

interface DocumentUploaderProps {
  companyId: string;
  agentId?: string;
  onUploadSuccess?: (doc: Document) => void;
}

export const DocumentUploader: React.FC<DocumentUploaderProps> = ({
  companyId,
  agentId,
  onUploadSuccess,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedDocs, setUploadedDocs] = useState<Document[]>([]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      handleFiles(files);
    }
  };

  const handleFiles = async (files: File[]) => {
    setError(null);
    setIsLoading(true);

    try {
      for (const file of files) {
        // Validate file type
        const allowedTypes = [
          "application/pdf",
          "text/plain",
          "text/markdown",
        ];
        if (!allowedTypes.includes(file.type)) {
          setError(`File type not supported: ${file.name}`);
          continue;
        }

        // Upload document
        const formData = new FormData();
        formData.append("file", file);
        formData.append("name", file.name);
        if (agentId) {
          formData.append("agentId", agentId);
        }

        const response = await fetch(
          `/api/companies/${companyId}/knowledge/documents`,
          {
            method: "POST",
            body: formData,
          }
        );

        if (!response.ok) {
          const data = await response.json();
          setError(data.error || "Upload failed");
        } else {
          const data = await response.json();
          if (data.documents) {
            setUploadedDocs(data.documents);
            if (onUploadSuccess && data.documents.length > 0) {
              onUploadSuccess(data.documents[data.documents.length - 1]);
            }
          }
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to upload documents");
    } finally {
      setIsLoading(false);
    }
  };

  const removeDocument = async (docId: string) => {
    try {
      const response = await fetch(
        `/api/companies/${companyId}/knowledge/documents/${docId}`,
        {
          method: "DELETE",
        }
      );

      if (response.ok) {
        setUploadedDocs(uploadedDocs.filter((doc) => doc.id !== docId));
      }
    } catch (err) {
      setError("Failed to delete document");
    }
  };

  return (
    <div className="space-y-4">
      {/* Upload Area */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 bg-gray-50"
        }`}
      >
        <Upload className="w-8 h-8 mx-auto mb-2 text-gray-400" />
        <p className="text-sm font-medium text-gray-700">
          Drag and drop documents here
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Supported: PDF, TXT, Markdown
        </p>
        <label className="mt-4 inline-block">
          <input
            type="file"
            multiple
            accept=".pdf,.txt,.md,.markdown"
            onChange={handleFileSelect}
            disabled={isLoading}
            className="hidden"
          />
          <span className="inline-block px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:bg-gray-400 cursor-pointer">
            {isLoading ? "Uploading..." : "Choose Files"}
          </span>
        </label>
      </div>

      {/* Error Message */}
      {error && (
        <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {/* Uploaded Documents */}
      {uploadedDocs.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">
            Uploaded Documents
          </h3>
          <div className="space-y-2">
            {uploadedDocs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {doc.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {doc.status === "ready" && (
                      <span className="text-green-600">
                        Ready • {doc.chunkCount || 0} chunks
                      </span>
                    )}
                    {doc.status === "processing" && (
                      <span className="text-amber-600">Processing...</span>
                    )}
                    {doc.status === "error" && (
                      <span className="text-red-600">
                        {doc.errorMessage || "Error"}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => removeDocument(doc.id)}
                  className="ml-2 p-1 text-gray-400 hover:text-red-600 rounded hover:bg-red-50"
                  title="Delete document"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
