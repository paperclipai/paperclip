// Minimal type declarations for File System Access API

interface FileSystemHandle {
  kind: "file" | "directory";
  name: string;
  getFile(): Promise<File>;
  getDirectoryHandle(
    name: string,
    options?: FileSystemHandleCreateOptions,
  ): Promise<FileSystemDirectoryHandle>;
}

interface FileSystemHandleCreateOptions {
  create?: boolean;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: "directory";
  values(): AsyncIterableIterator<FileSystemHandle>;
  getDirectoryHandle(
    name: string,
    options?: FileSystemHandleCreateOptions,
  ): Promise<FileSystemDirectoryHandle>;
}

interface FileSystemFileHandle extends FileSystemHandle {
  kind: "file";
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: FileSystemWriteChunkType): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
}

type FileSystemWriteChunkType = BufferSource | Blob | string | WriteParams;

interface WriteParams {
  type: "write" | "seek" | "truncate";
  size?: number;
  position?: number;
  data?: BufferSource | Blob | string;
}

interface Window {
  showDirectoryPicker(
    options?: DirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>;
}

interface DirectoryPickerOptions {
  mode?: "read" | "readwrite";
  startIn?:
    | FileSystemHandle
    | "desktop"
    | "documents"
    | "downloads"
    | "music"
    | "pictures"
    | "videos";
}
