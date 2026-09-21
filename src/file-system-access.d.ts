interface FileSystemWritableFileStream extends WritableStream {
    write(data: FileSystemWriteChunkType): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
}

type FileSystemWriteChunkType = BufferSource | Blob | string | WriteParams;

interface WriteParams {
    type: 'write';
    data: FileSystemWriteChunkType;
    position?: number;
}

interface FileSystemHandle {
    readonly kind: 'file' | 'directory';
    readonly name: string;
    isSameEntry(other: FileSystemHandle): Promise<boolean>;
}

interface FileSystemFileHandle extends FileSystemHandle {
    readonly kind: 'file';
    getFile(): Promise<File>;
    createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
    remove(options?: { recursive?: boolean }): Promise<void>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
    readonly kind: 'directory';
    values(): AsyncIterableIterator<FileSystemHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
}

interface Window {
    showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}
