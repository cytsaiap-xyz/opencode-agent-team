/**
 * TeamManager — In-memory team registry.
 * Tracks active agent team and validates tool permissions.
 *
 * Agent definitions are NOT written to disk because OpenCode only loads
 * agents at startup (no hot-reload). Instead, dynamic agent prompts are
 * injected into the "worker" subtask at dispatch time.
 */

import { resolvePermissions, type AgentSpec } from "./prompt-builder.js";

interface TeamState {
    sessionId: string;
    taskSummary: string;
    agents: AgentSpec[];
    createdAt: string;
}

interface TeamManagerConfig {
    maxTeamSize: number;
    permissionPresets: Record<string, string[]>;
}

export class TeamManager {
    private config: TeamManagerConfig;
    private activeTeam: TeamState | null = null;

    // Staging area for incremental team building
    private pendingTaskSummary: string | null = null;
    private pendingAgents: AgentSpec[] = [];

    constructor(config: TeamManagerConfig) {
        this.config = config;
    }

    /** Start planning a new team. Clears any existing team and staging area. */
    startTeam(taskSummary: string): void {
        if (this.activeTeam) {
            this.disbandTeam();
        }
        this.pendingTaskSummary = taskSummary;
        this.pendingAgents = [];
    }

    /** Whether a team is currently being planned (between startTeam and finalizeTeam). */
    isPlanning(): boolean {
        return this.pendingTaskSummary !== null;
    }

    /** Add one agent to the staging area. Returns warnings for unknown tools. */
    addAgent(spec: AgentSpec): { warnings: string[] } {
        if (!this.pendingTaskSummary) {
            throw new Error("No team planning in progress. Call plan_team first.");
        }

        if (this.pendingAgents.length >= this.config.maxTeamSize) {
            throw new Error(`Cannot add more agents — maximum team size is ${this.config.maxTeamSize}`);
        }

        if (this.pendingAgents.some(a => a.id === spec.id)) {
            throw new Error(`Duplicate agent ID "${spec.id}" — each agent must have a unique ID`);
        }

        const resolved: AgentSpec = {
            ...spec,
            permissions: resolvePermissions(spec.permissions, this.config.permissionPresets)
        };

        this.pendingAgents.push(resolved);
        return { warnings: [] };
    }

    /** Get the list of staged agents (before finalize). */
    getPendingAgents(): AgentSpec[] {
        return [...this.pendingAgents];
    }

    /** Finalize the staged agents into an active team. Requires 2+ agents. */
    finalizeTeam(): { team: TeamState; warnings: string[] } {
        if (!this.pendingTaskSummary) {
            throw new Error("No team planning in progress. Call plan_team first.");
        }

        if (this.pendingAgents.length < 2) {
            throw new Error(
                `Team needs at least 2 agents (currently ${this.pendingAgents.length}). ` +
                "Add more agents with add_agent before calling finalize_team."
            );
        }

        this.activeTeam = {
            sessionId: `team-${Date.now()}`,
            taskSummary: this.pendingTaskSummary,
            agents: [...this.pendingAgents],
            createdAt: new Date().toISOString()
        };

        // Clear staging
        this.pendingTaskSummary = null;
        this.pendingAgents = [];

        return { team: this.activeTeam, warnings: [] };
    }

    getAgent(agentId: string): AgentSpec | undefined {
        return this.activeTeam?.agents.find(a => a.id === agentId);
    }

    getActiveTeam(): TeamState | null {
        return this.activeTeam;
    }

    /**
     * Disband team: clear the in-memory registry.
     * Returns the list of removed agent IDs.
     */
    disbandTeam(): string[] {
        if (!this.activeTeam) {
            throw new Error("No active team to disband");
        }

        const removed = this.activeTeam.agents.map(a => a.id);
        this.activeTeam = null;
        return removed;
    }
}
