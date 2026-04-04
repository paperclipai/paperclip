import { useRef } from "react";
import { Search, FolderPlus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ArtifactToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  onCreateFolder: () => void;
  onUpload: (file: File) => void;
}

export function ArtifactToolbar({
  search,
  onSearchChange,
  onCreateFolder,
  onUpload,
}: ArtifactToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search files..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8 h-8"
        />
      </div>
      <div className="flex items-center gap-1 ml-auto">
        <Button variant="outline" size="sm" onClick={onCreateFolder}>
          <FolderPlus className="w-4 h-4 mr-1.5" />
          New Folder
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="w-4 h-4 mr-1.5" />
          Upload
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              onUpload(file);
              e.target.value = "";
            }
          }}
        />
      </div>
    </div>
  );
}
