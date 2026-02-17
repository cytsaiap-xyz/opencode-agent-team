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

                        // Send subtask part to parent session — OpenCode creates a native child session
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

                        // Poll parent session until subtask completes
                        for (let i = 0; i < 15; i++) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            const statusResult = await client.session.status({});
                            const statuses = statusResult.data as any;
                            const status = statuses?.[parentSessionId];
                            if (!status || status.type === "idle") {
                                return `[Agent ${args.agent_id}] Task completed.`;
                            }
                        }

                        return `[Agent ${args.agent_id}] Task dispatched, may still be running.`;
                    } catch (error) {
                        return `Delegation to ${args.agent_id} failed: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }),

            delegate_tasks: tool({
                description:
                    "Delegate multiple tasks in parallel. " +
                    "All tasks start concurrently and the tool returns when all complete (or timeout).",
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
                        // Send all subtask parts at once to parent session
                        const subtaskParts = args.tasks.map(t => {
                            const agent = teamManager.getAgent(t.agent_id)!;
                            return {
                                type: "subtask" as const,
                                prompt: `# Your Role: ${agent.name}\n\n${agent.system_prompt}\n\n# Task\n\n${t.task}`,
                                description: `[${agent.name}] ${agent.role}`,
                                agent: "worker"
                            };
                        });

                        await client.session.promptAsync({
                            path: { id: parentSessionId },
                            body: {
                                noReply: true,
                                parts: subtaskParts
                            }
                        });

                        console.log(`[agent-team] ${subtaskParts.length} subtasks dispatched on session ${parentSessionId}`);

                        // Poll until parent session is idle (all subtasks done)
                        for (let i = 0; i < 30; i++) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            const statusResult = await client.session.status({});
                            const statuses = statusResult.data as any;
                            const status = statuses?.[parentSessionId];
                            if (!status || status.type === "idle") {
                                break;
                            }
                        }

                        return `Parallel delegation: ${args.tasks.length} subtasks dispatched.`;
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
