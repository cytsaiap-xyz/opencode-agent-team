/**
 * Prompt Builder — Generates agent .md files for OpenCode subagent discovery
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
 * Build a full agent markdown file with YAML frontmatter.
 * OpenCode reads these from .opencode/agents/ to register subagents.
 * Each subagent gets its own tools/permissions in the frontmatter.
 */
export function buildAgentMarkdown(spec: AgentSpec): string {
    const toolEntries = spec.permissions.map(p => `  ${p}: true`).join("\n");

    return `---
description: ${spec.role}
mode: subagent
tools:
${toolEntries}
---

# ${spec.name}

${spec.system_prompt}
`;
}

/**
 * Resolve a permission preset name to its tool list.
 */
export function resolvePermissions(
    permissions: string[],
    presets: Record<string, string[]>
): string[] {
    if (permissions.length === 1 && presets[permissions[0]]) {
        return presets[permissions[0]];
    }
    return permissions;
}
