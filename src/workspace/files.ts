/**
 * @module src/workspace/files
 *
 * Purpose:
 * Simple in-memory workspace file store used by OR3 Net preview and staging
 * flows in development-oriented scenarios.
 *
 * Constraints:
 * - Storage is process-local and non-persistent
 * - Enforces conservative file count and file size limits
 */
import type { WorkspaceFileEntry } from "../contracts/index.ts";

interface StoredFile {
  readonly entry: WorkspaceFileEntry;
  readonly content: string;
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_WORKSPACE = 500;

/**
 * Purpose:
 * Keeps small workspace files in memory for quick preview and file-serving
 * flows.
 */
export class InMemoryWorkspaceFileService {
  private readonly files = new Map<string, Map<string, StoredFile>>();

  /** Purpose: Stores or replaces a workspace file after enforcing size limits. */
  public putFile(workspaceId: string, entry: WorkspaceFileEntry, content: string): void {
    const workspaceFiles = this.files.get(workspaceId) ?? new Map<string, StoredFile>();
    if (content.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`file exceeds maximum size of ${String(MAX_FILE_SIZE_BYTES)} bytes`);
    }
    if (workspaceFiles.size >= MAX_FILES_PER_WORKSPACE && !workspaceFiles.has(entry.path)) {
      throw new Error(`workspace file limit of ${String(MAX_FILES_PER_WORKSPACE)} reached`);
    }
    workspaceFiles.set(entry.path, { entry, content });
    this.files.set(workspaceId, workspaceFiles);
  }

  /** Purpose: Lists known file entries for a workspace. */
  public listFiles(workspaceId: string): WorkspaceFileEntry[] {
    return Array.from(this.files.get(workspaceId)?.values() ?? []).map((file) => file.entry);
  }

  /** Purpose: Reads a stored file entry and its in-memory content. */
  public readFile(workspaceId: string, path: string): { entry: WorkspaceFileEntry; content: string } {
    const file = this.files.get(workspaceId)?.get(path);
    if (file === undefined) {
      throw new Error(`file ${path} was not found in workspace ${workspaceId}`);
    }
    return file;
  }
}