import { writeFile, readFile, mkdir, rm, readdir } from "fs/promises";
import { join } from "path";
import { buildAgentMarkdown, resolvePermissions, type AgentSpec } from "./prompt-builder.js";

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

/**
 * TeamManager — Writes/removes agent .md files in .opencode/agents/
 * so OpenCode discovers them as subagents with their own permissions.
 * The plan agent then calls them via the native @agent-id mechanism.
 */
export class TeamManager {
    private agentsDir: string;
    private config: TeamManagerConfig;
    private statePath: string;
    private activeTeam: TeamState | null = null;

    constructor(agentsDir: string, config: TeamManagerConfig) {
        this.agentsDir = agentsDir;
        this.config = config;
        this.statePath = join(agentsDir, ".agent-team-state.json");
    }

    async loadState(): Promise<void> {
        try {
            const raw = await readFile(this.statePath, "utf-8");
            this.activeTeam = JSON.parse(raw);
        } catch {
            this.activeTeam = null;
        }
    }

    private async saveState(): Promise<void> {
        await mkdir(this.agentsDir, { recursive: true });
        if (this.activeTeam) {
            await writeFile(this.statePath, JSON.stringify(this.activeTeam, null, 2), "utf-8");
        } else {
            try { await rm(this.statePath, { force: true }); } catch { /* ignore */ }
        }
    }

    /**
     * Build a team: write .md files to .opencode/agents/ for each agent.
     * Each file defines mode: subagent with its own tools/permissions.
     */
    async buildTeam(taskSummary: string, agentSpecs: AgentSpec[]): Promise<TeamState> {
        if (agentSpecs.length > this.config.maxTeamSize) {
            throw new Error(`Team size ${agentSpecs.length} exceeds maximum of ${this.config.maxTeamSize}`);
        }
        if (agentSpecs.length === 0) {
            throw new Error("At least one agent spec is required");
        }

        const ids = agentSpecs.map(a => a.id);
        if (new Set(ids).size !== ids.length) {
            throw new Error("Duplicate agent IDs found in team spec");
        }

        // Disband existing team first
        if (this.activeTeam) {
            await this.disbandTeam();
        }

        await mkdir(this.agentsDir, { recursive: true });

        const resolvedSpecs: AgentSpec[] = [];
        for (const spec of agentSpecs) {
            const resolved: AgentSpec = {
                ...spec,
                permissions: resolvePermissions(spec.permissions, this.config.permissionPresets)
            };
            resolvedSpecs.push(resolved);

            // Write the agent .md file — OpenCode discovers it as a subagent
            const markdown = buildAgentMarkdown(resolved);
            const filePath = join(this.agentsDir, `${resolved.id}.md`);
            await writeFile(filePath, markdown, "utf-8");
            console.log(`[agent-team] Wrote agent file: ${resolved.id}.md`);
        }

        this.activeTeam = {
            sessionId: `team-${Date.now()}`,
            taskSummary,
            agents: resolvedSpecs,
            createdAt: new Date().toISOString()
        };

        await this.saveState();
        return this.activeTeam;
    }

    getAgent(agentId: string): AgentSpec | undefined {
        return this.activeTeam?.agents.find(a => a.id === agentId);
    }

    getActiveTeam(): TeamState | null {
        return this.activeTeam;
    }

    /**
     * Disband team: remove dynamically-created agent .md files.
     * Never removes plan.md.
     */
    async disbandTeam(): Promise<string[]> {
        if (!this.activeTeam) {
            throw new Error("No active team to disband");
        }

        const removed: string[] = [];
        for (const agent of this.activeTeam.agents) {
            const filePath = join(this.agentsDir, `${agent.id}.md`);
            try {
                await rm(filePath, { force: true });
                removed.push(agent.id);
                console.log(`[agent-team] Removed agent file: ${agent.id}.md`);
            } catch { /* ignore */ }
        }

        this.activeTeam = null;
        await this.saveState();
        return removed;
    }
}
