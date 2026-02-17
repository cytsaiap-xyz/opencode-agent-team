import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { join } from "path";
import { TeamManager } from "./team-manager.js";
import type { AgentSpec } from "./prompt-builder.js";

const DEFAULT_CONFIG = {
    maxTeamSize: 6,
    permissionPresets: {
        reader: ["read", "glob", "grep", "list"],
        writer: ["read", "write", "edit", "glob", "grep", "list", "bash"],
        full: ["read", "write", "edit", "glob", "grep", "list", "bash", "subagent"]
    }
} as const;

interface PendingSubtask {
    prompt: string;
    description: string;
}

/**
 * Agent Team Plugin for OpenCode
 *
 * Uses a deferred dispatch pattern:
 * 1. delegate_task/delegate_tasks store subtask specs and return immediately
 * 2. When the orchestrator's session becomes idle, the event handler
 *    sends SubtaskPartInput to the parent session
 * 3. OpenCode creates native child sessions (Ctrl+X works)
 * 4. No deadlock because dispatch happens when session is free
 */
export const AgentTeamPlugin: Plugin = async (ctx) => {
    const { directory, client } = ctx;

    const agentsDir = join(directory, ".opencode", "agents");
    const teamManager = new TeamManager(agentsDir, {
        maxTeamSize: DEFAULT_CONFIG.maxTeamSize,
        permissionPresets: {
            reader: [...DEFAULT_CONFIG.permissionPresets.reader],
            writer: [...DEFAULT_CONFIG.permissionPresets.writer],
            full: [...DEFAULT_CONFIG.permissionPresets.full]
        }
    });
    await teamManager.loadState();

    // Track the orchestrator's session ID
    let parentSessionId: string | undefined;

    // Queue of subtasks waiting to be dispatched when session is idle
    let pendingSubtasks: PendingSubtask[] = [];
    let dispatching = false;

    console.log("[agent-team] Plugin initialized — orchestrator ready");

    /** Send all pending subtasks to the parent session */
    async function dispatchPending() {
        if (dispatching || pendingSubtasks.length === 0 || !parentSessionId) return;
        dispatching = true;

        const parts = pendingSubtasks.map(s => ({
            type: "subtask" as const,
            prompt: s.prompt,
            description: s.description,
            agent: "worker"
        }));
        pendingSubtasks = [];

        try {
            await client.session.promptAsync({
                path: { id: parentSessionId },
                body: {
                    noReply: true,
                    parts
                }
            });
            console.log(`[agent-team] ${parts.length} subtask(s) dispatched to parent session`);
        } catch (err) {
            console.error(`[agent-team] Failed to dispatch subtasks: ${err}`);
        } finally {
            dispatching = false;
        }
    }

    return {
        event: async ({ event }) => {
            if (event.type === "session.created") {
                const sessionId = (event as any).properties?.info?.id;
                if (sessionId && !parentSessionId) {
                    parentSessionId = sessionId;
                    console.log(`[agent-team] Parent session: ${sessionId}`);
                }
            }

            // When the orchestrator's session becomes idle, dispatch pending subtasks
            if (event.type === "session.idle") {
                await dispatchPending();
            }
        },

        tool: {
            build_team: tool({
                description:
                    "Create a team of specialized subagents for the current task. " +
                    "After building, use delegate_task or delegate_tasks to send work to agents.",
                args: {
                    task_summary: tool.schema
                        .string()
                        .describe("High-level summary of the task"),
                    agents: tool.schema
                        .array(
                            tool.schema.object({
                                id: tool.schema
                                    .string()
                                    .describe("Agent identifier in kebab-case (e.g. frontend-dev)"),
                                name: tool.schema
                                    .string()
                                    .describe("Display name"),
                                role: tool.schema
                                    .string()
                                    .describe("One-line role description"),
                                system_prompt: tool.schema
                                    .string()
                                    .describe("Full system prompt — identity, instructions, constraints"),
                                skills: tool.schema
                                    .array(tool.schema.string())
                                    .describe("Skill tags"),
                                permissions: tool.schema
                                    .array(tool.schema.string())
                                    .describe(
                                        "Use a preset (reader, writer, full) or explicit tool list"
                                    )
                            })
                        )
                        .describe("Array of agent specifications")
                },
                async execute(args) {
                    try {
                        const agentSpecs: AgentSpec[] = args.agents.map((a) => ({
                            id: a.id,
                            name: a.name,
                            role: a.role,
                            system_prompt: a.system_prompt,
                            skills: a.skills,
                            permissions: a.permissions
                        }));

                        const team = await teamManager.buildTeam(args.task_summary, agentSpecs);

                        const agentSummary = team.agents
                            .map(a => `  - ${a.id} (${a.name}): ${a.role}`)
                            .join("\n");

                        return [
                            `Team "${team.sessionId}" created with ${team.agents.length} agent(s):`,
                            agentSummary,
                            "",
                            `Use delegate_task or delegate_tasks to send work to agents.`,
                            `Call disband_team when finished.`
                        ].join("\n");
                    } catch (error) {
                        return `Failed to build team: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }),

            delegate_task: tool({
                description:
                    "Delegate a single task to one subagent. " +
                    "The subtask is queued and starts when the session is ready. " +
                    "Use Ctrl+X to monitor progress. " +
                    "For parallel execution, use delegate_tasks instead.",
                args: {
                    agent_id: tool.schema
                        .string()
                        .describe("ID of the agent to delegate to (from build_team)"),
                    task: tool.schema
                        .string()
                        .describe("Detailed task description for the agent to execute")
                },
                async execute(args) {
                    const agent = teamManager.getAgent(args.agent_id);
                    if (!agent) {
                        return `Agent "${args.agent_id}" not found in active team. Use build_team first.`;
                    }

                    if (!parentSessionId) {
                        return `No parent session found. Cannot delegate.`;
                    }

                    const fullPrompt = `# Your Role: ${agent.name}\n\n${agent.system_prompt}\n\n# Task\n\n${args.task}`;

                    // Queue the subtask — it will be dispatched when session becomes idle
                    pendingSubtasks.push({
                        prompt: fullPrompt,
                        description: `[${agent.name}] ${agent.role}`
                    });

                    console.log(`[agent-team] Subtask queued for ${args.agent_id} (pending: ${pendingSubtasks.length})`);
                    return `[Agent ${args.agent_id}] Task queued. Will start after current turn completes. Use Ctrl+X to monitor.`;
                }
            }),

            delegate_tasks: tool({
                description:
                    "Delegate multiple tasks in parallel. " +
                    "All subtasks are queued and start when the session is ready. " +
                    "Use Ctrl+X to monitor progress.",
                args: {
                    tasks: tool.schema
                        .array(
                            tool.schema.object({
                                agent_id: tool.schema.string().describe("Agent ID from build_team"),
                                task: tool.schema.string().describe("Task description")
                            })
                        )
                        .describe("Array of {agent_id, task} pairs to run in parallel")
                },
                async execute(args) {
                    for (const t of args.tasks) {
                        if (!teamManager.getAgent(t.agent_id)) {
                            return `Agent "${t.agent_id}" not found. Use build_team first.`;
                        }
                    }

                    if (!parentSessionId) {
                        return `No parent session found. Cannot delegate.`;
                    }

                    // Queue all subtasks — dispatched together when session becomes idle
                    for (const t of args.tasks) {
                        const agent = teamManager.getAgent(t.agent_id)!;
                        const fullPrompt = `# Your Role: ${agent.name}\n\n${agent.system_prompt}\n\n# Task\n\n${t.task}`;

                        pendingSubtasks.push({
                            prompt: fullPrompt,
                            description: `[${agent.name}] ${agent.role}`
                        });
                    }

                    const agentIds = args.tasks.map(t => t.agent_id).join(", ");
                    console.log(`[agent-team] ${args.tasks.length} subtasks queued (${agentIds})`);
                    return `${args.tasks.length} tasks queued (${agentIds}). They will start after the current turn completes. Use Ctrl+X to monitor progress.`;
                }
            }),

            list_team: tool({
                description: "List the current active agent team and their roles",
                args: {},
                async execute() {
                    const team = teamManager.getActiveTeam();
                    if (!team) {
                        return "No active team. Use build_team to create one.";
                    }

                    return JSON.stringify(
                        {
                            sessionId: team.sessionId,
                            taskSummary: team.taskSummary,
                            createdAt: team.createdAt,
                            agents: team.agents.map(a => ({
                                id: a.id, name: a.name, role: a.role,
                                skills: a.skills, permissions: a.permissions
                            }))
                        },
                        null,
                        2
                    );
                }
            }),

            disband_team: tool({
                description: "Disband the current agent team and remove agent files.",
                args: {},
                async execute() {
                    try {
                        const removed = await teamManager.disbandTeam();
                        return `Team disbanded. Removed ${removed.length} agent(s): ${removed.join(", ")}`;
                    } catch (error) {
                        return `Failed to disband team: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            })
        }
    };
};

export default AgentTeamPlugin;
