/**
 * @module src/workspace/host-staging
 *
 * Purpose:
 * Resolves host-workspace staging configuration from stored workspace metadata.
 */
import path from "node:path";
import { z } from "zod";

import type { StoredWorkspace } from "../db/schema.ts";
import { nonEmptyStringSchema } from "../contracts/shared.ts";

const hostWorkspaceConfigSchema = z.object({
  host_workspace: z
    .object({
      root: nonEmptyStringSchema,
      enabled: z.boolean().default(true),
    })
    .optional(),
});

/** Purpose: Optional parameters for resolving a host workspace root path. */
export interface ResolveHostWorkspaceRootOptions {
  readonly baseDir?: string;
}

/** Purpose: Reads host-workspace staging config from a stored workspace record. */
export const getHostWorkspaceConfig = (workspace: StoredWorkspace): { root: string; enabled: boolean } | null => {
  const parsed = hostWorkspaceConfigSchema.parse(workspace.config ?? {});
  if (!parsed.host_workspace?.enabled) {
    return null;
  }
  return parsed.host_workspace;
};

/**
 * Purpose:
 * Resolves the absolute host-workspace root for a workspace when host staging is
 * enabled.
 */
export const resolveHostWorkspaceRoot = (workspace: StoredWorkspace, options: ResolveHostWorkspaceRootOptions = {}): string | null => {
  const config = getHostWorkspaceConfig(workspace);
  if (config === null) {
    return null;
  }
  return path.resolve(options.baseDir ?? process.cwd(), config.root);
};