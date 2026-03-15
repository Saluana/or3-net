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

export interface ResolveHostWorkspaceRootOptions {
  readonly baseDir?: string;
}

export const getHostWorkspaceConfig = (workspace: StoredWorkspace): { root: string; enabled: boolean } | null => {
  const parsed = hostWorkspaceConfigSchema.parse(workspace.config ?? {});
  if (!parsed.host_workspace?.enabled) {
    return null;
  }
  return parsed.host_workspace;
};

export const resolveHostWorkspaceRoot = (workspace: StoredWorkspace, options: ResolveHostWorkspaceRootOptions = {}): string | null => {
  const config = getHostWorkspaceConfig(workspace);
  if (config === null) {
    return null;
  }
  return path.resolve(options.baseDir ?? process.cwd(), config.root);
};