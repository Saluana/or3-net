import type { WorkspaceFileEntry } from "../contracts/index.ts";

interface StoredFile {
  readonly entry: WorkspaceFileEntry;
  readonly content: string;
}

export class InMemoryWorkspaceFileService {
  private readonly files = new Map<string, Map<string, StoredFile>>();

  public putFile(workspaceId: string, entry: WorkspaceFileEntry, content: string): void {
    const workspaceFiles = this.files.get(workspaceId) ?? new Map<string, StoredFile>();
    workspaceFiles.set(entry.path, { entry, content });
    this.files.set(workspaceId, workspaceFiles);
  }

  public listFiles(workspaceId: string): WorkspaceFileEntry[] {
    return Array.from(this.files.get(workspaceId)?.values() ?? []).map((file) => file.entry);
  }

  public readFile(workspaceId: string, path: string): { entry: WorkspaceFileEntry; content: string } {
    const file = this.files.get(workspaceId)?.get(path);
    if (file === undefined) {
      throw new Error(`file ${path} was not found in workspace ${workspaceId}`);
    }
    return file;
  }
}