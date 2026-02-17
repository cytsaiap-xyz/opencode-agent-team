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

/**
 * Agent Team Plugin for OpenCode
 *
 * The orchestrator agent designs a team, build_team stores agent specs,
 * and delegate_task creates child sessions via the SDK with the agent's
 * system prompt and tool permissions.
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

    // Track the orchestrator's session ID for subtask linking
    let parentSessionId: string | undefined;

    console.log("[agent-team] Plugin initialized — orchestrator ready");

    return {
        event: async ({ event }) => {
            if (event.type === "session.created") {
                const sessionId = (event as any).properties?.info?.id;
                // Only capture the first session as parent (the orchestrator)
                if (sessionId && !parentSessionId) {
                    parentSessionId = sessionId;
                    console.log(`[agent-team] Parent session: ${sessionId}`);
                }
            }
        },

        tool: {
            build_team: tool({
                description:
                    "Create a team of specialized subagents for the current task. " +
                    "After building, use delegate_task to send work to each agent.",
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
                            `Use delegate_task to send work to each agent.`,
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
                    "The subtask runs asynchronously — use Ctrl+X to view progress. " +
                    "For parallel execution of multiple tasks, use delegate_tasks instead.",
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

                    try {
                        const fullPrompt = `# Your Role: ${agent.name}\n\n${agent.system_prompt}\n\n# Task\n\n${args.task}`;

                        // Fire-and-forget: dispatch subtask to parent session.
                        // Do NOT poll — polling from within the parent session's tool
                        // execution deadlocks when the child finishes and reports back.
                        await client.session.promptAsync({
                            path: { id: parentSessionId },
                            body: {
                                noReply: true,
                                parts: [{
                                    type: "subtask" as const,
                                    prompt: fullPrompt,
                                    description: `[${agent.name}] ${agent.role}`,
                                    agent: "worker"
                                }]
                            }
                        });
                        console.log(`[agent-team] Subtask dispatched for agent ${args.agent_id} on session ${parentSessionId}`);

                        return `[Agent ${args.agent_id}] Subtask dispatched. Running in background.`;
                    } catch (error) {
                        return `Delegation to ${args.agent_id} failed: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }),

            delegate_tasks: tool({
                description:
                    "Delegate multiple tasks in parallel. " +
                    "Each subtask launches as a separate child session. " +
                    "Returns immediately — use Ctrl+X to view progress.",
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

                    try {
                        // Dispatch each subtask as a separate promptAsync call
                        // so they run as truly independent child sessions.
                        // Do NOT poll — polling from within the parent session's
                        // tool execution deadlocks when children finish.
                        const dispatched: string[] = [];

                        for (const t of args.tasks) {
                            const agent = teamManager.getAgent(t.agent_id)!;
                            await client.session.promptAsync({
                                path: { id: parentSessionId },
                                body: {
                                    noReply: true,
                                    parts: [{
                                        type: "subtask" as const,
                                        prompt: `# Your Role: ${agent.name}\n\n${agent.system_prompt}\n\n# Task\n\n${t.task}`,
                                        description: `[${agent.name}] ${agent.role}`,
                                        agent: "worker"
                                    }]
                                }
                            });
                            dispatched.push(t.agent_id);
                            console.log(`[agent-team] Subtask dispatched for agent ${t.agent_id}`);
                        }

                        return `Parallel delegation: ${dispatched.length} subtasks dispatched (${dispatched.join(", ")}). All running in background.`;
                    } catch (error) {
                        return `Failed to launch tasks: ${error instanceof Error ? error.message : String(error)}`;
                    }
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
