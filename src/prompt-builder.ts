/**
 * Prompt Builder — Constructs delegation prompts for subagent dispatch
 */

export interface AgentSpec {
    id: string;
    name: string;
    role: string;
    system_prompt: string;
    skills: string[];
    permissions: string[];
}

/**
 * Resolve permission preset names to tool lists.
 * Expands all preset names found in the array, keeps non-preset strings as-is.
 */
export function resolvePermissions(
    permissions: string[],
    presets: Record<string, string[]>
): string[] {
    const resolved = new Set<string>();
    for (const p of permissions) {
        if (presets[p]) {
            for (const tool of presets[p]) resolved.add(tool);
        } else {
            resolved.add(p);
        }
    }
    return [...resolved];
}

/**
 * Build the full delegation prompt sent via SubtaskPartInput.
 * Includes agent identity, skill context (if any), and the task.
 */
export function buildDelegationPrompt(
    agent: AgentSpec,
    task: string,
    skillContext: string
): string {
    const parts: string[] = [
        `# Your Role: ${agent.name}`,
        "",
        agent.system_prompt
    ];

    if (skillContext) {
        parts.push("", skillContext);
    }

    parts.push("", "# Task", "", task);

    return parts.join("\n");
}
