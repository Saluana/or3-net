import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { StoredWorkspace } from "../../src/db/schema.ts";
import { resolveHostWorkspaceRoot } from "../../src/workspace/host-staging.ts";
import {
  diffWorkspaceStage,
  scanWorkspaceSelection,
  selectWorkspaceStageTransport,
  type WorkspaceStageManifest,
} from "../../src/runtime/workspace-stage.ts";

describe("workspace stage helpers", () => {
  test("normalizes configured host workspace roots against the provided base directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "or3-host-root-"));
    try {
      const workspace: StoredWorkspace = {
        workspace_id: "ws_test",
        name: "Test",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
        config: {
          host_workspace: {
            enabled: true,
            root: "./fixtures/project",
          },
        },
      };
      expect(resolveHostWorkspaceRoot(workspace, { baseDir: root })).toBe(path.resolve(root, "fixtures/project"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selects archive for directories and file_api for file-only fallbacks", () => {
    const directoryManifest: WorkspaceStageManifest = {
      selected_paths: ["src"],
      entries: [
        { path: "src", kind: "directory", size_bytes: 0, modified_at: "2024-01-01T00:00:00.000Z" },
        { path: "src/index.ts", kind: "file", size_bytes: 1, modified_at: "2024-01-01T00:00:00.000Z", sha256: "dir-file" },
      ],
    };
    const fileManifest: WorkspaceStageManifest = {
      selected_paths: ["README.md"],
      entries: [
        { path: "README.md", kind: "file", size_bytes: 1, modified_at: "2024-01-01T00:00:00.000Z", sha256: "readme" },
      ],
    };

    expect(selectWorkspaceStageTransport("auto", ["src"], directoryManifest, { archive: true, file_api: true })).toBe("archive");
    expect(selectWorkspaceStageTransport("auto", ["src"], directoryManifest, { archive: false, file_api: true })).toBe("file_api");
    expect(selectWorkspaceStageTransport("auto", ["README.md"], fileManifest, { archive: true, file_api: true })).toBe("file_api");
  });

  test("captures manifest entries and classifies write, delete, and conflict diffs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "or3-stage-manifest-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "index.ts"), "host-a\n", "utf8");
      writeFileSync(path.join(root, "README.md"), "readme\n", "utf8");

      const baseManifest = await scanWorkspaceSelection(root, ["src", "README.md"]);
      expect(baseManifest.entries.map((entry) => entry.path)).toEqual(["README.md", "src", "src/index.ts"]);
      const srcDirectory = baseManifest.entries.find((entry) => entry.path === "src");
      const readmeEntry = baseManifest.entries.find((entry) => entry.path === "README.md");
      if (srcDirectory === undefined || readmeEntry === undefined) {
        throw new Error("expected base manifest entries to be present");
      }

      const exportedManifest: WorkspaceStageManifest = {
        selected_paths: ["src", "README.md"],
        entries: [
          srcDirectory,
          {
            path: "src/index.ts",
            kind: "file" as const,
            size_bytes: 7,
            modified_at: "2024-01-02T00:00:00.000Z",
            sha256: "sandbox-index",
          },
        ],
      };
      const currentHostManifest: WorkspaceStageManifest = {
        selected_paths: ["src", "README.md"],
        entries: [
          srcDirectory,
          {
            path: "src/index.ts",
            kind: "file" as const,
            size_bytes: 4,
            modified_at: "2024-01-02T00:00:00.000Z",
            sha256: "host-index",
          },
          {
            path: "README.md",
            kind: "file" as const,
            size_bytes: 7,
            modified_at: readmeEntry.modified_at,
            ...(readmeEntry.sha256 === undefined ? {} : { sha256: readmeEntry.sha256 }),
          },
        ],
      };

      const diff = diffWorkspaceStage(baseManifest, currentHostManifest, exportedManifest);
      expect(diff.written_paths).toEqual([]);
      expect(diff.deleted_paths).toEqual(["README.md"]);
      expect(diff.conflict_paths).toEqual(["src/index.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
