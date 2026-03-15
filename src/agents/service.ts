/**
 * @module src/agents/service
 *
 * Purpose:
 * Thin service layer for CRUD-style access to stored workspace agents.
 *
 * Non-responsibilities:
 * - Does not execute agents
 * - Does not validate scheduling or runtime compatibility beyond schema checks
 */
import type { Agent } from "../contracts/index.ts";
import type { ControlPlaneDatabase, StoredAgent } from "../db/index.ts";

/**
 * Purpose:
 * Provides workspace-scoped persistence operations for reusable agent
 * definitions.
 */
export class AgentService {
  public constructor(private readonly database: ControlPlaneDatabase) {}

  /** Purpose: Lists all saved agents for a workspace. */
  public listAgents(workspaceId: string): StoredAgent[] {
    return this.database.workspace(workspaceId).listAgents();
  }

  /** Purpose: Fetches a single saved agent by id. */
  public getAgent(workspaceId: string, agentId: string): StoredAgent {
    return this.database.workspace(workspaceId).getAgent(agentId);
  }

  /** Purpose: Creates or updates a stored agent definition. */
  public saveAgent(workspaceId: string, agentInput: Agent): StoredAgent {
    return this.database.workspace(workspaceId).saveAgent(agentInput);
  }

  /** Purpose: Deletes a stored agent definition. */
  public deleteAgent(workspaceId: string, agentId: string): void {
    this.database.workspace(workspaceId).deleteAgent(agentId);
  }
}