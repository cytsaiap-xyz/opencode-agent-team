/**
 * Skills Loader — Discovers SKILL.md files from official OpenCode skill directories
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface SkillDefinition {
    name: string;
    description: string;
    content: string;
    source: "project" | "global";
    /** Absolute path to the skill's root directory (parent of SKILL.md) */
    rootDir: string;
}

export type SkillsRegistry = Map<string, SkillDefinition>;

/** Scan official OpenCode skill dirs, return loaded skills. Project overrides global. */
export async function loadAllSkills(projectDir: string): Promise<SkillsRegistry> {
    const registry: SkillsRegistry = new Map();

    // Load global skills first so project skills can override
    const globalDir = join(homedir(), ".config", "opencode", "skills");
    await loadSkillsFromDir(globalDir, "global", registry);

    // Load project-local skills (overrides global)
    const projectSkillsDir = join(projectDir, ".opencode", "skills");
    await loadSkillsFromDir(projectSkillsDir, "project", registry);

    // Load universal agent skills (.agents/skills/ — installed by npx skills)
    const universalSkillsDir = join(projectDir, ".agents", "skills");
    await loadSkillsFromDir(universalSkillsDir, "project", registry);

    return registry;
}

async function loadSkillsFromDir(
    skillsDir: string,
    source: "project" | "global",
    registry: SkillsRegistry
): Promise<void> {
    let entries: string[];
    try {
        entries = await readdir(skillsDir);
    } catch {
        return; // Directory doesn't exist — skip silently
    }

    for (const dirName of entries) {
        const skillDir = join(skillsDir, dirName);
        const skillPath = join(skillDir, "SKILL.md");
        let raw: string;
        try {
            raw = await readFile(skillPath, "utf-8");
        } catch {
            continue; // No SKILL.md in this directory
        }

        try {
            const parsed = parseSkillFile(raw, dirName);
            registry.set(parsed.name, {
                name: parsed.name,
                description: parsed.description,
                content: parsed.content,
                source,
                rootDir: skillDir
            });
        } catch {
            // Failed to parse skill — skip silently
        }
    }
}

/** Parse SKILL.md frontmatter (name, description) + body content. */
function parseSkillFile(
    raw: string,
    dirName: string
): { name: string; description: string; content: string } {
    const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

    if (!frontmatterMatch) {
        return { name: dirName, description: "", content: raw.trim() };
    }

    const frontmatter = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();

    let name = dirName;
    let description = "";

    for (const line of frontmatter.split("\n")) {
        const nameMatch = line.match(/^name:\s*(.+)/);
        if (nameMatch) name = nameMatch[1].trim();

        const descMatch = line.match(/^description:\s*(.+)/);
        if (descMatch) description = descMatch[1].trim();
    }

    return { name, description, content: body };
}

/** Build a context block from selected skills to inject into a worker prompt. */
export function buildSkillContext(skills: SkillsRegistry, skillNames: string[]): string {
    const sections: string[] = [];

    for (const name of skillNames) {
        const skill = skills.get(name);
        if (skill) {
            sections.push(`## ${skill.name}\n\n${skill.content}`);
        }
    }

    if (sections.length === 0) return "";

    return `# Relevant Skills\n\n${sections.join("\n\n---\n\n")}`;
}
