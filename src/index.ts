import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { TeamManager } from "./team-manager.js";
import { buildDelegationPrompt, type AgentSpec } from "./prompt-builder.js";
import { loadAllSkills, buildSkillContext, type SkillsRegistry } from "./skills-loader.js";
import { loadAgentTeamConfig } from "./config-loader.js";
import { loadAgentDefs } from "./agent-defs.js";

const DEFAULT_CONFIG = {
    maxTeamSize: 6,
    permissionPresets: {
        reader: ["read", "glob", "grep", "list"],
        writer: ["read", "write", "edit", "glob", "grep", "list", "bash"],
        full: ["read", "write", "edit", "glob", "grep", "list", "bash", "subagent"]
    }
} as const;

// Resolve the plugin package root (parent of src/)
const PLUGIN_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const BUILTIN_AGENTS = ["plan", "build", "general", "explore"] as const;

export const AgentTeamPlugin: Plugin = async (ctx) => {
    const { directory, client } = ctx;

    // Load toggle config and agent definitions
    const pluginConfig = loadAgentTeamConfig(directory);
    const agentDefs = loadAgentDefs(PLUGIN_DIR);

    const log = (...args: unknown[]) => { if (pluginConfig.verbose) console.log("[agent-team]", ...args); };
    const warn = (...args: unknown[]) => { if (pluginConfig.verbose) console.warn("[agent-team]", ...args); };

    log(`Config: enabled=${pluginConfig.enabled}, agents loaded: ${Object.keys(agentDefs).join(", ") || "none"}`);

    const teamManager = new TeamManager({
        maxTeamSize: DEFAULT_CONFIG.maxTeamSize,
        permissionPresets: {
            reader: [...DEFAULT_CONFIG.permissionPresets.reader],
            writer: [...DEFAULT_CONFIG.permissionPresets.writer],
            full: [...DEFAULT_CONFIG.permissionPresets.full]
        }
    });

    // Load skills from filesystem (no server dependency — safe at init time)
    let skills: SkillsRegistry = new Map();
    try {
        skills = await loadAllSkills(directory);
        log(`Loaded ${skills.size} skill(s): ${[...skills.keys()].join(", ")}`);
    } catch (err) {
        warn(`Could not load skills: ${err}`);
    }

    // Track the orchestrator's session ID
    let parentSessionId: string | undefined;

    // Lock to enforce one delegation at a time
    let delegationInProgress = false;

    log("Plugin initialized");


    /**
     * Dispatch via SubtaskPartInput (visible in Ctrl+X UI), then discover
     * the new subtask session, poll until idle, and return results.
     */
    async function dispatchSubtask(agentId: string, prompt: string, description: string): Promise<string> {
        if (!parentSessionId) {
            return "ERROR: No parent session found. Cannot dispatch subtask.";
        }

        const POLL_INTERVAL_MS = 3000;
        const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

        try {
            // 1. Snapshot existing session IDs before dispatch
            const existingIds = new Set<string>();
            try {
                const beforeStatus = await client.session.status({ query: { directory } });
                if (beforeStatus.data) {
                    for (const id of Object.keys(beforeStatus.data as Record<string, unknown>)) {
                        existingIds.add(id);
                    }
                }
            } catch {}

            // 2. Dispatch via SubtaskPartInput — visible in OpenCode UI (Ctrl+X)
            await client.session.promptAsync({
                path: { id: parentSessionId },
                body: {
                    parts: [{
                        type: "subtask" as const,
                        prompt,
                        description,
                        agent: agentId
                    }]
                }
            });

            log(`Subtask dispatched: ${description}`);

            // 3. Discover the new subtask session by diffing status
            let subtaskSessionId: string | undefined;
            const discoveryStart = Date.now();

            while (Date.now() - discoveryStart < 30000) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const statusResult = await client.session.status({ query: { directory } });
                    if (statusResult.data) {
                        const statusMap = statusResult.data as Record<string, { type: string }>;
                        for (const id of Object.keys(statusMap)) {
                            if (!existingIds.has(id)) {
                                subtaskSessionId = id;
                                break;
                            }
                        }
                    }
                } catch {}
                if (subtaskSessionId) break;
            }

            if (!subtaskSessionId) {
                return `Subtask dispatched: ${description}\nCould not track session for result — use Ctrl+X to monitor.`;
            }

            log(`Subtask session: ${subtaskSessionId}`);

            // 4. Poll until subtask session is idle
            const startTime = Date.now();
            let completed = false;

            while (Date.now() - startTime < MAX_WAIT_MS) {
                try {
                    const statusResult = await client.session.status({ query: { directory } });
                    if (statusResult.data) {
                        const statusMap = statusResult.data as Record<string, { type: string }>;
                        const status = statusMap[subtaskSessionId];
                        if (!status || status.type === "idle") {
                            completed = true;
                            break;
                        }
                        if (status.type === "retry") {
                            log(`Session ${subtaskSessionId} retrying...`);
                        }
                    }
                } catch {}

                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            }

            if (!completed) {
                return `WARNING: Subtask "${description}" timed out after 10 minutes.`;
            }

            log(`Subtask completed: ${description}`);

            // 5. Extract result text from subtask messages
            try {
                const msgsResult = await client.session.messages({
                    path: { id: subtaskSessionId },
                    query: { directory }
                });

                if (msgsResult.data) {
                    const messages = msgsResult.data as Array<{ info: unknown; parts: Array<{ type: string; text?: string }> }>;
                    for (let i = messages.length - 1; i >= 0; i--) {
                        const parts = messages[i].parts || [];
                        const textParts = parts
                            .filter(p => p.type === "text" && p.text)
                            .map(p => p.text as string);

                        if (textParts.length > 0) {
                            const text = textParts.join("\n");
                            const summary = text.length > 3000
                                ? text.substring(0, 3000) + "\n...(truncated)"
                                : text;
                            return `COMPLETED: ${description}\n\n${summary}`;
                        }
                    }
                }
            } catch (msgErr) {
                warn(`Could not retrieve messages: ${msgErr}`);
            }

            return `COMPLETED: ${description}\n(No text output retrieved)`;
        } catch (err) {
            warn(`dispatchSubtask failed: ${err}`);
            return `ERROR: Subtask "${description}" failed: ${err}`;
        }
    }

    // Define all tools — only exposed when enabled
    const allTools = {
        plan_team: tool({
            description:
                "CALL THIS FIRST. Start planning a new agent team. " +
                "After this, call add_agent for each agent, then finalize_team.",
            args: {
                task_summary: tool.schema
                    .string()
                    .describe("High-level summary of the overall task")
            },
            async execute(args) {
                try {
                    teamManager.startTeam(args.task_summary);
                    return [
                        `Team planning started for: ${args.task_summary}`,
                        "",
                        "Now call add_agent for each specialized agent (minimum 2).",
                        "Then call finalize_team to lock in the team."
                    ].join("\n");
                } catch (error) {
                    return `Failed to start team: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
        }),

        add_agent: tool({
            description:
                "Add one agent to the team being planned. Call after plan_team. " +
                "Each call adds one agent. Repeat for each agent needed.",
            args: {
                id: tool.schema
                    .string()
                    .describe("Unique agent ID in kebab-case (e.g. auth-model-dev)"),
                role: tool.schema
                    .string()
                    .describe("One-line role description"),
                system_prompt: tool.schema
                    .string()
                    .describe("Detailed instructions for the agent: file paths, function signatures, approach, constraints"),
                skills: tool.schema
                    .string()
                    .describe("Comma-separated skill names from Available Skills, or empty string if none needed"),
                permissions: tool.schema
                    .string()
                    .describe("Permission preset: reader, writer, or full")
            },
            async execute(args) {
                try {
                    const skillsList = args.skills.trim()
                        ? args.skills.split(",").map(s => s.trim()).filter(Boolean)
                        : [];
                    const permsList = args.permissions.split(",").map(s => s.trim()).filter(Boolean);

                    const spec: AgentSpec = {
                        id: args.id,
                        name: args.role,
                        role: args.role,
                        system_prompt: args.system_prompt,
                        skills: skillsList,
                        permissions: permsList
                    };

                    const { warnings } = teamManager.addAgent(spec);
                    const pending = teamManager.getPendingAgents();

                    const lines = [
                        `Agent "${args.id}" added (${args.role}).`,
                        `Team now has ${pending.length} agent(s): ${pending.map(a => a.id).join(", ")}`,
                    ];

                    if (pending.length < 2) {
                        lines.push("Add at least 1 more agent before calling finalize_team.");
                    } else {
                        lines.push("You can add more agents or call finalize_team to lock in the team.");
                    }

                    if (warnings.length > 0) {
                        lines.push("", "Warnings:", ...warnings.map(w => `  - ${w}`));
                    }

                    return lines.join("\n");
                } catch (error) {
                    return `Failed to add agent: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
        }),

        finalize_team: tool({
            description:
                "Finalize the team after adding all agents. Requires 2+ agents. " +
                "After this, call delegate_task ONE AT A TIME for each agent.",
            args: {},
            async execute() {
                try {
                    const { team, warnings } = teamManager.finalizeTeam();

                    const agentSummary = team.agents
                        .map(a => `  - ${a.id}: ${a.role}`)
                        .join("\n");

                    const lines = [
                        `Team finalized with ${team.agents.length} agent(s):`,
                        agentSummary,
                        "",
                        `Now call delegate_task for EACH agent ONE AT A TIME.`,
                        `Each call blocks until that agent finishes. After ALL complete, call disband_team.`
                    ];

                    if (warnings.length > 0) {
                        lines.push("", "Warnings:", ...warnings.map(w => `  - ${w}`));
                    }

                    return lines.join("\n");
                } catch (error) {
                    return `Failed to finalize team: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
        }),

        delegate_task: tool({
            description:
                "Delegate a task to one subagent and WAIT for it to complete. " +
                "Returns the result summary. Call once per agent, sequentially.",
            args: {
                agent_id: tool.schema
                    .string()
                    .describe("ID of the agent to delegate to (from build_team)"),
                task: tool.schema
                    .string()
                    .describe("Short task instruction (detailed spec is in the agent's system_prompt)")
            },
            async execute(args) {
                if (teamManager.isPlanning()) {
                    return `ERROR: Team is still being planned. Call finalize_team first before delegating.`;
                }
                if (!teamManager.getActiveTeam()) {
                    return `ERROR: No team exists. Call plan_team → add_agent → finalize_team first.`;
                }

                // Enforce one delegation at a time
                if (delegationInProgress) {
                    return `ERROR: Another delegation is already in progress. Wait for it to complete before calling delegate_task again. Call delegate_task only ONCE per message.`;
                }

                const agent = teamManager.getAgent(args.agent_id);
                if (!agent) {
                    return `ERROR: Agent "${args.agent_id}" not found. Available agents: ${teamManager.getActiveTeam()!.agents.map(a => a.id).join(", ")}`;
                }

                const skillContext = buildSkillContext(skills, agent.skills);
                const fullPrompt = buildDelegationPrompt(agent, args.task, skillContext);

                // Lock to prevent parallel delegations
                delegationInProgress = true;
                try {
                    // Always dispatch to "worker" agent (the only subagent OpenCode knows at runtime)
                    // The dynamic agent prompt is injected into the subtask prompt
                    return await dispatchSubtask(
                        "worker",
                        fullPrompt,
                        `[${agent.name}] ${args.task}`
                    );
                } finally {
                    delegationInProgress = false;
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
                            id: a.id, role: a.role,
                            skills: a.skills, permissions: a.permissions
                        }))
                    },
                    null,
                    2
                );
            }
        }),

        disband_team: tool({
            description: "Disband the current agent team. Call AFTER all subtasks have completed and results reviewed.",
            args: {},
            async execute() {
                try {
                    const removed = teamManager.disbandTeam();
                    return `Team disbanded. Removed ${removed.length} agent(s): ${removed.join(", ")}`;
                } catch (error) {
                    return `Failed to disband team: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
        })
    };

    return {
        config: async (config) => {
            if (!pluginConfig.enabled) return;

            // Disable built-in agents
            config.agent = config.agent ?? {};
            for (const name of BUILTIN_AGENTS) {
                config.agent[name] = { ...config.agent[name], disable: true };
            }

            // Build skills list to inject into orchestrator prompt
            let skillsSection = "";
            if (skills.size > 0) {
                const skillLines = [...skills.values()].map(
                    s => `- **${s.name}**${s.description ? `: ${s.description}` : ""}`
                );
                skillsSection = `\n\n## Available Skills\n\nAssign these to agents via the \`skills\` field in \`add_agent\` (comma-separated). Skill content is automatically injected into the agent's prompt during delegation.\n\n${skillLines.join("\n")}`;
            }

            // Register agent-team agents (user overrides in opencode.json take precedence)
            for (const [name, def] of Object.entries(agentDefs)) {
                const merged = { ...def, ...config.agent[name] };
                // Append skills list to orchestrator prompt
                if (name === "orchestrator" && skillsSection && merged.prompt) {
                    merged.prompt = merged.prompt + skillsSection;
                }
                config.agent[name] = merged;
            }
        },

        event: async ({ event }) => {
            if (event.type === "session.created") {
                const props = (event as { properties?: { info?: { id?: string } } }).properties;
                if (props?.info?.id && !parentSessionId) {
                    parentSessionId = props.info.id;
                    log(`Parent session: ${parentSessionId}`);
                }
            }
        },

        tool: pluginConfig.enabled ? allTools : {}
    };
};

export default AgentTeamPlugin;
