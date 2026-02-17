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

/** Poll a session until it becomes idle or timeout */
async function waitForSession(
    client: any,
    sessionId: string,
    timeoutMs: number = 120_000
): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 1500));
        try {
            const statusResult = await client.session.status({});
            const statuses = statusResult.data as any;
            const status = statuses?.[sessionId];
            if (!status || status.type === "idle") {
                return true; // completed
            }
        } catch {
            // status check failed, keep polling
        }
    }
    return false; // timed out
}

/**
 * Agent Team Plugin for OpenCode
 *
 * The orchestrator agent designs a team, build_team stores agent specs,
 * and delegate_task creates independent worker sessions via the SDK
 * with the agent's system prompt and tool permissions.
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

    console.log("[agent-team] Plugin initialized — orchestrator ready");

    return {
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
                    "Creates an independent worker session and waits for it to complete. " +
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

                    try {
                        const fullPrompt = `# Your Role: ${agent.name}\n\n${agent.system_prompt}\n\n# Task\n\n${args.task}`;

                        // Create an independent worker session (not a child of the parent)
                        const sessionResult = await client.session.create({
                            body: { title: `[${agent.name}] ${agent.role}` }
                        });
                        const sessionId = (sessionResult.data as any)?.id;
                        if (!sessionId) {
                            return `Failed to create worker session for ${args.agent_id}`;
                        }
                        console.log(`[agent-team] Worker session ${sessionId} created for ${args.agent_id}`);

                        // Send the task to the worker session
                        await client.session.promptAsync({
                            path: { id: sessionId },
                            body: {
                                agent: "worker",
                                system: fullPrompt,
                                parts: [{
                                    type: "text" as const,
                                    text: args.task
                                }]
                            }
                        });

                        // Poll the WORKER session (not the parent) — no deadlock
                        const completed = await waitForSession(client, sessionId, 120_000);

                        if (completed) {
                            return `[Agent ${args.agent_id}] Task completed successfully.`;
                        }
                        return `[Agent ${args.agent_id}] Task may still be running (timeout after 120s).`;
                    } catch (error) {
                        return `Delegation to ${args.agent_id} failed: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }),

            delegate_tasks: tool({
                description:
                    "Delegate multiple tasks in parallel. " +
                    "Creates independent worker sessions for each task and waits for all to complete.",
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

                    try {
                        // Step 1: Create all worker sessions and dispatch prompts
                        const workers: { agentId: string; sessionId: string }[] = [];

                        for (const t of args.tasks) {
                            const agent = teamManager.getAgent(t.agent_id)!;
                            const fullPrompt = `# Your Role: ${agent.name}\n\n${agent.system_prompt}\n\n# Task\n\n${t.task}`;

                            const sessionResult = await client.session.create({
                                body: { title: `[${agent.name}] ${agent.role}` }
                            });
                            const sessionId = (sessionResult.data as any)?.id;
                            if (!sessionId) {
                                console.error(`[agent-team] Failed to create session for ${t.agent_id}`);
                                continue;
                            }

                            await client.session.promptAsync({
                                path: { id: sessionId },
                                body: {
                                    agent: "worker",
                                    system: fullPrompt,
                                    parts: [{
                                        type: "text" as const,
                                        text: t.task
                                    }]
                                }
                            });

                            workers.push({ agentId: t.agent_id, sessionId });
                            console.log(`[agent-team] Worker session ${sessionId} created for ${t.agent_id}`);
                        }

                        if (workers.length === 0) {
                            return "Failed to create any worker sessions.";
                        }

                        // Step 2: Poll ALL worker sessions until all idle (or timeout)
                        const start = Date.now();
                        const timeoutMs = 180_000; // 3 minutes for parallel
                        const results: string[] = [];

                        while (Date.now() - start < timeoutMs) {
                            await new Promise(r => setTimeout(r, 1500));
                            try {
                                const statusResult = await client.session.status({});
                                const statuses = statusResult.data as any;

                                const allDone = workers.every(w => {
                                    const s = statuses?.[w.sessionId];
                                    return !s || s.type === "idle";
                                });

                                if (allDone) break;
                            } catch {
                                // status check failed, keep polling
                            }
                        }

                        for (const w of workers) {
                            results.push(`  - ${w.agentId}: completed`);
                        }

                        return [
                            `Parallel delegation: ${workers.length} tasks completed.`,
                            ...results
                        ].join("\n");
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
