import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import tar from "tar-stream";
import type { Headers as TarHeaders } from "tar-stream";
import { z } from "zod";

export interface WorkspaceStageManifestEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size_bytes: number;
  readonly modified_at: string;
  readonly sha256?: string;
}

export interface WorkspaceStageManifest {
  readonly selected_paths: string[];
  readonly entries: WorkspaceStageManifestEntry[];
}

export interface WorkspaceStageDiff {
  readonly written_paths: string[];
  readonly deleted_paths: string[];
  readonly conflict_paths: string[];
}

export interface WorkspaceStageTransportCapabilities {
  readonly archive: boolean;
  readonly file_api: boolean;
}

const STAGE_ROOT_DIRNAME = "workspace-stage";

const workspaceStageManifestEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size_bytes: z.number(),
  modified_at: z.string(),
  sha256: z.string().optional(),
});

const workspaceStageManifestSchema = z.object({
  selected_paths: z.array(z.string()),
  entries: z.array(workspaceStageManifestEntrySchema),
});

export const getWorkspaceStageRoot = (baseDir = process.cwd()): string => path.join(baseDir, ".data", STAGE_ROOT_DIRNAME);

export const getWorkspaceStageSessionDir = (sessionId: string, baseDir = process.cwd()): string =>
  path.join(getWorkspaceStageRoot(baseDir), sessionId);

export const normalizeStagePath = (requestedPath: string): string => {
  const normalized = requestedPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.trim() === "") {
    return "";
  }
  const cleaned = path.posix.normalize(normalized);
  if (cleaned === "." || cleaned === "") {
    return "";
  }
  if (cleaned === ".." || cleaned.startsWith("../")) {
    throw new Error(`path escapes workspace: ${requestedPath}`);
  }
  return cleaned;
};

export const resolveWithinRoot = (root: string, relativePath: string): string => {
  const target = path.resolve(root, normalizeStagePath(relativePath));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`path escapes workspace root: ${relativePath}`);
  }
  return target;
};

export const ensureWorkspaceStageDir = async (sessionId: string, baseDir = process.cwd()): Promise<string> => {
  const dir = getWorkspaceStageSessionDir(sessionId, baseDir);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

export const writeBaseManifest = async (
  sessionId: string,
  manifest: WorkspaceStageManifest,
  baseDir = process.cwd(),
): Promise<string> => {
  const stageDir = await ensureWorkspaceStageDir(sessionId, baseDir);
  const manifestPath = path.join(stageDir, "base-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
};

export const readBaseManifest = async (sessionId: string, baseDir = process.cwd()): Promise<WorkspaceStageManifest> => {
  const manifestPath = path.join(getWorkspaceStageSessionDir(sessionId, baseDir), "base-manifest.json");
  const parsed = workspaceStageManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  return {
    selected_paths: parsed.selected_paths,
    entries: parsed.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      size_bytes: entry.size_bytes,
      modified_at: entry.modified_at,
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    })),
  };
};

export const clearWorkspaceStage = async (sessionId: string, baseDir = process.cwd()): Promise<void> => {
  await fs.rm(getWorkspaceStageSessionDir(sessionId, baseDir), { recursive: true, force: true });
};

export const scanWorkspaceSelection = async (root: string, selectedPaths: readonly string[]): Promise<WorkspaceStageManifest> => {
  const uniquePaths = [...new Set(selectedPaths.map((entry) => normalizeStagePath(entry)).filter((entry) => entry !== ""))].sort();
  const entries = new Map<string, WorkspaceStageManifestEntry>();
  for (const selectedPath of uniquePaths) {
    const target = resolveWithinRoot(root, selectedPath);
    const stats = await fs.stat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (stats === null) {
      continue;
    }
    await collectManifestEntries(root, selectedPath, target, entries);
  }
  return {
    selected_paths: uniquePaths,
    entries: [...entries.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
};

const collectManifestEntries = async (
  root: string,
  relativePath: string,
  absolutePath: string,
  entries: Map<string, WorkspaceStageManifestEntry>,
): Promise<void> => {
  const stats = await fs.lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`symlink entries are not allowed in staged workspaces: ${relativePath}`);
  }
  const normalizedPath = normalizeStagePath(relativePath);
  if (stats.isDirectory()) {
    entries.set(normalizedPath, {
      path: normalizedPath,
      kind: "directory",
      size_bytes: 0,
      modified_at: stats.mtime.toISOString(),
    });
    for (const child of (await fs.readdir(absolutePath)).sort()) {
      await collectManifestEntries(root, path.posix.join(normalizedPath, child), path.join(absolutePath, child), entries);
    }
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`unsupported workspace entry kind for ${relativePath}`);
  }
  entries.set(normalizedPath, {
    path: normalizedPath,
    kind: "file",
    size_bytes: stats.size,
    modified_at: stats.mtime.toISOString(),
    sha256: await sha256File(absolutePath),
  });
};

const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
};

const entrySignature = (entry: WorkspaceStageManifestEntry | undefined): string => {
  if (entry === undefined) {
    return "missing";
  }
  return `${entry.kind}:${entry.kind === "file" ? entry.sha256 ?? "" : ""}`;
};

export const diffWorkspaceStage = (
  baseManifest: WorkspaceStageManifest,
  currentHostManifest: WorkspaceStageManifest,
  exportedManifest: WorkspaceStageManifest,
): WorkspaceStageDiff => {
  const baseEntries = new Map(baseManifest.entries.map((entry) => [entry.path, entry]));
  const hostEntries = new Map(currentHostManifest.entries.map((entry) => [entry.path, entry]));
  const exportedEntries = new Map(exportedManifest.entries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...baseEntries.keys(), ...hostEntries.keys(), ...exportedEntries.keys()])].sort();
  const writtenPaths: string[] = [];
  const deletedPaths: string[] = [];
  const conflictPaths: string[] = [];

  for (const candidatePath of allPaths) {
    const baseEntry = baseEntries.get(candidatePath);
    const hostEntry = hostEntries.get(candidatePath);
    const exportedEntry = exportedEntries.get(candidatePath);
    const sandboxChanged = entrySignature(baseEntry) !== entrySignature(exportedEntry);
    const hostChanged = entrySignature(baseEntry) !== entrySignature(hostEntry);
    if (sandboxChanged && hostChanged && entrySignature(hostEntry) !== entrySignature(exportedEntry)) {
      conflictPaths.push(candidatePath);
      continue;
    }
    if (entrySignature(hostEntry) === entrySignature(exportedEntry)) {
      continue;
    }
    if (exportedEntry === undefined) {
      if (hostEntry?.kind === "file") {
        deletedPaths.push(candidatePath);
      }
      continue;
    }
    if (exportedEntry.kind === "file") {
      writtenPaths.push(candidatePath);
    }
  }

  return { written_paths: writtenPaths, deleted_paths: deletedPaths, conflict_paths: conflictPaths };
};

export const applyWorkspaceStageDiff = async (
  hostRoot: string,
  exportRoot: string,
  diff: WorkspaceStageDiff,
  sessionId: string,
  baseDir = process.cwd(),
): Promise<void> => {
  const stageDir = await ensureWorkspaceStageDir(sessionId, baseDir);
  const backupDir = path.join(stageDir, "rollback-backup");
  const createdPaths = new Set<string>();
  const backedUpFiles = new Map<string, string>();
  await fs.mkdir(backupDir, { recursive: true });
  try {
    for (const relativePath of diff.written_paths) {
      const sourcePath = resolveWithinRoot(exportRoot, relativePath);
      const targetPath = resolveWithinRoot(hostRoot, relativePath);
      const backupPath = path.join(backupDir, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const existing = await fs.stat(targetPath).catch(() => null);
      if (existing?.isFile() === true) {
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.copyFile(targetPath, backupPath);
        backedUpFiles.set(relativePath, backupPath);
      } else if (existing === null) {
        createdPaths.add(relativePath);
      }
      await fs.copyFile(sourcePath, targetPath);
    }

    for (const relativePath of diff.deleted_paths) {
      const targetPath = resolveWithinRoot(hostRoot, relativePath);
      const existing = await fs.stat(targetPath).catch(() => null);
      if (existing?.isFile() !== true) {
        continue;
      }
      const backupPath = path.join(backupDir, relativePath);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.copyFile(targetPath, backupPath);
      backedUpFiles.set(relativePath, backupPath);
      await fs.rm(targetPath, { force: true });
    }
  } catch (error: unknown) {
    await Promise.all(
      [...backedUpFiles.entries()].map(async ([relativePath, backupPath]) => {
        const targetPath = resolveWithinRoot(hostRoot, relativePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(backupPath, targetPath);
      }),
    );
    await Promise.all(
      [...createdPaths].map(async (relativePath) => {
        await fs.rm(resolveWithinRoot(hostRoot, relativePath), { force: true });
      }),
    );
    throw error;
  }
};

export const reconstructExportFromFileApi = async (
  destinationRoot: string,
  trackedFilePaths: readonly string[],
  reader: (relativePath: string) => Promise<string | null>,
): Promise<WorkspaceStageManifest> => {
  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.mkdir(destinationRoot, { recursive: true });
  const selected = [...new Set(trackedFilePaths.map((entry) => normalizeStagePath(entry)).filter((entry) => entry !== ""))].sort();
  for (const relativePath of selected) {
    const content = await reader(relativePath);
    if (content === null) {
      continue;
    }
    const targetPath = resolveWithinRoot(destinationRoot, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
  }
  return await scanWorkspaceSelection(destinationRoot, selected);
};

export const selectWorkspaceStageTransport = (
  requestedTransport: "auto" | "archive" | "file_api",
  selectedPaths: readonly string[],
  manifest: WorkspaceStageManifest,
  capabilities: WorkspaceStageTransportCapabilities,
): "archive" | "file_api" => {
  const hasDirectories = manifest.entries.some((entry) => entry.kind === "directory");
  if (requestedTransport === "archive") {
    if (!capabilities.archive) {
      throw new Error("archive transport is unavailable");
    }
    return "archive";
  }
  if (requestedTransport === "file_api") {
    if (!capabilities.file_api) {
      throw new Error("file_api transport is unavailable");
    }
    return "file_api";
  }
  if (hasDirectories && capabilities.archive) {
    return "archive";
  }
  if (capabilities.file_api) {
    return "file_api";
  }
  if (capabilities.archive) {
    return "archive";
  }
  throw new Error(`no supported workspace staging transport for ${selectedPaths.join(", ")}`);
};

export const createWorkspaceArchive = async (
  hostRoot: string,
  manifest: WorkspaceStageManifest,
  outputPath: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const pack = tar.pack();
  const output = createWriteStream(outputPath);
  const gzip = createGzip();
  const done = pipeline(pack, gzip, output);
  for (const entry of manifest.entries) {
    const absolutePath = resolveWithinRoot(hostRoot, entry.path);
    if (entry.kind === "directory") {
      await new Promise<void>((resolve, reject) => {
        pack.entry({ name: entry.path, type: "directory", mode: 0o755 }, (error?: Error | null) => {
          if (error != null) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      continue;
    }
    const buffer = await fs.readFile(absolutePath);
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: entry.path, type: "file", mode: 0o644, size: buffer.length }, buffer, (error?: Error | null) => {
        if (error != null) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  pack.finalize();
  await done;
};

export const extractWorkspaceArchive = async (
  archivePath: string,
  destinationRoot: string,
  limits: { max_bytes?: number; max_files?: number } = {},
): Promise<void> => {
  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.mkdir(destinationRoot, { recursive: true });
  const extract = tar.extract();
  let fileCount = 0;
  let totalBytes = 0;

  extract.on("entry", (header: TarHeaders, stream: NodeJS.ReadableStream, next: () => void) => {
    void (async () => {
      try {
        const relativePath = normalizeStagePath(header.name);
        const targetPath = resolveWithinRoot(destinationRoot, relativePath);
        switch (header.type) {
          case "directory":
            await fs.mkdir(targetPath, { recursive: true });
            await drain(stream);
            break;
          case "file": {
            fileCount += 1;
            totalBytes += header.size ?? 0;
            if (limits.max_files !== undefined && fileCount > limits.max_files) {
              throw new Error(`archive exceeds max file count ${String(limits.max_files)}`);
            }
            if (limits.max_bytes !== undefined && totalBytes > limits.max_bytes) {
              throw new Error(`archive exceeds max bytes ${String(limits.max_bytes)}`);
            }
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await pipeline(stream, createWriteStream(targetPath));
            break;
          }
          case null:
          case undefined:
          case "link":
          case "symlink":
          case "character-device":
          case "block-device":
          case "fifo":
          case "contiguous-file":
          case "pax-header":
          case "pax-global-header":
          case "gnu-long-link-path":
          case "gnu-long-path":
          default:
            throw new Error(`unsupported archive entry type: ${header.type ?? "unknown"}`);
        }
        next();
      } catch (error) {
        extract.destroy(error as Error);
      }
    })();
  });

  await pipeline(createReadStream(archivePath), createGunzip(), extract);
};

const drain = async (stream: NodeJS.ReadableStream): Promise<void> => {
  for await (const _chunk of stream as AsyncIterable<unknown>) {
    void _chunk;
  }
};