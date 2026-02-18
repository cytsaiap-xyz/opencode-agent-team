/**
 * Config Loader — Reads agent-team toggle state from .opencode/agent-team.json
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface AgentTeamConfig {
    enabled: boolean;
    verbose: boolean;
}

/**
 * Load the agent-team config from the project's .opencode/agent-team.json.
 * Returns { enabled: true, verbose: false } by default if the file doesn't exist.
 */
export function loadAgentTeamConfig(projectDir: string): AgentTeamConfig {
    const configPath = join(projectDir, ".opencode", "agent-team.json");

    try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);

        return {
            enabled: parsed.enabled !== false,
            verbose: parsed.verbose === true
        };
    } catch {
        return { enabled: true, verbose: false };
    }
}
