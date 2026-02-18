/**
 * Agent Definitions — Parses agent .md files into AgentConfig objects
 * for injection via the OpenCode config handler.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { AgentConfig } from "@opencode-ai/sdk";

interface ParsedFrontmatter {
    frontmatter: Record<string, string>;
    tools: Record<string, boolean>;
    permission: Record<string, string>;
    body: string;
}

/**
 * Parse YAML-ish frontmatter from an agent .md file.
 * Handles top-level key:value, indented `tools:` block, and indented `permission:` block.
 */
function parseFrontmatter(raw: string): ParsedFrontmatter {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, tools: {}, permission: {}, body: raw.trim() };
    }

    const frontmatter: Record<string, string> = {};
    const tools: Record<string, boolean> = {};
    const permission: Record<string, string> = {};
    let currentBlock: "none" | "tools" | "permission" = "none";

    for (const line of match[1].split("\n")) {
        // Detect block starts (top-level key with no value, followed by indented entries)
        if (line.match(/^tools:\s*$/)) {
            currentBlock = "tools";
            continue;
        }
        if (line.match(/^permission:\s*$/)) {
            currentBlock = "permission";
            continue;
        }

        // Parse indented entries within a block
        if (currentBlock !== "none") {
            const indentedMatch = line.match(/^\s+([\w_]+):\s*(.+)\s*$/);
            if (indentedMatch) {
                if (currentBlock === "tools") {
                    tools[indentedMatch[1]] = indentedMatch[2] === "true";
                } else if (currentBlock === "permission") {
                    permission[indentedMatch[1]] = indentedMatch[2];
                }
                continue;
            }
            // Non-indented line ends the block
            currentBlock = "none";
        }

        // Parse top-level key: value
        const kvMatch = line.match(/^(\w+):\s*(.+)/);
        if (kvMatch) {
            frontmatter[kvMatch[1]] = kvMatch[2].trim();
        }
    }

    return { frontmatter, tools, permission, body: match[2].trim() };
}

/**
 * Load agent .md files from the plugin's agents/ directory and return
 * them as AgentConfig objects ready for injection into Config.agent.
 *
 * @param pluginDir - The root directory of the agent-team package
 */
export function loadAgentDefs(pluginDir: string): Record<string, AgentConfig> {
    const agentsDir = join(pluginDir, "agents");
    const agents: Record<string, AgentConfig> = {};

    for (const name of ["orchestrator", "worker"]) {
        const filePath = join(agentsDir, `${name}.md`);

        let raw: string;
        try {
            raw = readFileSync(filePath, "utf-8");
        } catch {
            // Agent definition not found — skip silently
            continue;
        }

        const { frontmatter, tools, permission, body } = parseFrontmatter(raw);

        const config: AgentConfig = {
            prompt: body,
        };

        if (frontmatter.description) {
            config.description = frontmatter.description;
        }

        if (frontmatter.mode) {
            config.mode = frontmatter.mode as AgentConfig["mode"];
        }

        if (Object.keys(tools).length > 0) {
            config.tools = tools;
        }

        if (Object.keys(permission).length > 0) {
            config.permission = permission as AgentConfig["permission"];
        }

        agents[name] = config;
    }

    return agents;
}
