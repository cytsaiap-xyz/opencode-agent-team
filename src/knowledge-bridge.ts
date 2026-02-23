/**
 * Knowledge Bridge — Connects the orchestrator to auto-code-buddy's
 * knowledge base and experience databases when both plugins coexist.
 *
 * - Detects auto-code-buddy installation via the skills registry
 * - Reads knowledge-base/_index.json and experience/_index.json
 * - Loads all category and experience content files
 * - Provides formatted context strings for orchestrator and worker prompts
 *
 * This module is a no-op when auto-code-buddy is not installed.
 */

import { readFile } from "fs/promises";
import { join } from "path";

// ─── Types ───────────────────────────────────────────────────────────

interface KnowledgeCategory {
    id: string;
    name: string;
    keywords: string[];
    file: string;
    count: number;
}

interface KnowledgeIndex {
    lastUpdated: string;
    version: string;
    totalEntries: number;
    categories: KnowledgeCategory[];
    absorbedSkills: string[];
}

interface ExperienceEntry {
    skillId: string;
    file: string;
    keywords: string[];
    count: number;
}

interface ExperienceIndex {
    lastUpdated: string;
    version: string;
    skills: ExperienceEntry[];
}

export interface KnowledgeContext {
    /** Absolute path to the auto-code-buddy root directory */
    basePath: string;
    /** Parsed knowledge-base index */
    knowledgeIndex: KnowledgeIndex;
    /** Parsed experience index */
    experienceIndex: ExperienceIndex;
    /** category-id → file content (only categories with count > 0 or existing files) */
    categoryContents: Map<string, string>;
    /** skill-id → file content */
    experienceContents: Map<string, string>;
}

// ─── Loading ─────────────────────────────────────────────────────────

/**
 * Attempt to load auto-code-buddy's knowledge context.
 * Returns null if auto-code-buddy is not found or its databases are unreadable.
 */
export async function loadKnowledgeContext(
    autoBuddyDir: string
): Promise<KnowledgeContext | null> {
    try {
        // Read both index files
        const [kbRaw, expRaw] = await Promise.all([
            readFile(join(autoBuddyDir, "knowledge-base", "_index.json"), "utf-8"),
            readFile(join(autoBuddyDir, "experience", "_index.json"), "utf-8"),
        ]);

        const knowledgeIndex: KnowledgeIndex = JSON.parse(kbRaw);
        const experienceIndex: ExperienceIndex = JSON.parse(expRaw);

        // Load category content files (best-effort — skip missing ones)
        const categoryContents = new Map<string, string>();
        await Promise.all(
            knowledgeIndex.categories.map(async (cat) => {
                try {
                    const content = await readFile(
                        join(autoBuddyDir, "knowledge-base", cat.file),
                        "utf-8"
                    );
                    if (content.trim()) {
                        categoryContents.set(cat.id, content.trim());
                    }
                } catch {
                    // File doesn't exist yet — skip
                }
            })
        );

        // Load experience content files (best-effort)
        const experienceContents = new Map<string, string>();
        await Promise.all(
            experienceIndex.skills.map(async (skill) => {
                try {
                    const content = await readFile(
                        join(autoBuddyDir, "experience", skill.file),
                        "utf-8"
                    );
                    if (content.trim()) {
                        experienceContents.set(skill.skillId, content.trim());
                    }
                } catch {
                    // File doesn't exist yet — skip
                }
            })
        );

        return {
            basePath: autoBuddyDir,
            knowledgeIndex,
            experienceIndex,
            categoryContents,
            experienceContents,
        };
    } catch {
        return null;
    }
}

// ─── Orchestrator context ────────────────────────────────────────────

/**
 * Build a knowledge section to append to the orchestrator's system prompt.
 * Gives the orchestrator awareness of accumulated knowledge and experience
 * so it can write better system_prompts and make smarter delegation decisions.
 */
export function buildOrchestratorKnowledgeSection(ctx: KnowledgeContext): string {
    const sections: string[] = [
        "## Accumulated Knowledge & Experience (from auto-code-buddy)",
        "",
        "The project has an auto-code-buddy knowledge system installed. " +
        "Use the knowledge and experience below to write better agent system_prompts. " +
        "Reference relevant best practices, known pitfalls, and proven solutions when delegating tasks.",
    ];

    // Knowledge base summary
    if (ctx.categoryContents.size > 0) {
        sections.push("", "### Knowledge Base");
        for (const [catId, content] of ctx.categoryContents) {
            const cat = ctx.knowledgeIndex.categories.find(c => c.id === catId);
            const label = cat ? cat.name : catId;
            sections.push("", `#### ${label}`, "", content);
        }
    }

    // Experience summary
    if (ctx.experienceContents.size > 0) {
        sections.push("", "### Past Skill Experiences");
        for (const [skillId, content] of ctx.experienceContents) {
            sections.push("", `#### ${skillId}`, "", content);
        }
    }

    // Available categories (even if empty, so orchestrator knows the taxonomy)
    if (ctx.categoryContents.size === 0 && ctx.experienceContents.size === 0) {
        sections.push(
            "",
            "No knowledge or experience has been recorded yet. " +
            "Instruct workers to record reusable learnings after completing their tasks " +
            "(see the recording protocol in their prompts)."
        );
    }

    // Category index for keyword awareness
    const catList = ctx.knowledgeIndex.categories
        .map(c => `- **${c.name}** (${c.id}): ${c.keywords.join(", ")}`)
        .join("\n");
    sections.push(
        "",
        "### Knowledge Categories (for keyword matching)",
        "",
        catList,
    );

    return "\n\n" + sections.join("\n");
}

// ─── Worker recording instructions ──────────────────────────────────

/**
 * Build recording instructions to append to worker delegation prompts.
 * Workers have full file access, so they can write to the knowledge base
 * and experience databases after completing their task.
 */
export function buildWorkerRecordingInstructions(ctx: KnowledgeContext): string {
    const basePath = ctx.basePath;

    return [
        "# Experience & Knowledge Recording (auto-code-buddy integration)",
        "",
        "After completing your task, if you produced a reusable solution, discovered a pitfall, " +
        "or learned something that would save time in the future, record it using the protocol below.",
        "",
        "## When to Record",
        "",
        "**SHOULD record:**",
        "- Pitfalls encountered and their solutions (including error messages, debugging approaches)",
        "- Key parameters or configurations that affect results",
        "- Reusable workflows, templates, or patterns",
        "- Dependencies or important file paths discovered",
        "- Solutions that required multiple attempts",
        "",
        "**Should NOT record:**",
        "- Pure conceptual explanations with no concrete steps",
        "- One-off operations that won't recur",
        "- Trivial changes with no learning value",
        "",
        "## How to Record",
        "",
        "### For general knowledge (workflows, best practices, preferences):",
        `1. Read \`${join(basePath, "knowledge-base", "_index.json")}\``,
        "2. Match your work against the category keywords to find the right category",
        `3. Append an entry to \`${join(basePath, "knowledge-base", "[category-id].md")}\` using this format:`,
        "```markdown",
        "## [Short Title]",
        "**Date:** YYYY-MM-DD",
        "**Situation:** One-sentence description of the use case",
        "**Best Practices:**",
        "- [Key point 1]",
        "- [Key point 2]",
        "```",
        `4. Update the \`count\` and \`totalEntries\` in \`${join(basePath, "knowledge-base", "_index.json")}\``,
        `5. Update \`lastUpdated\` to today's date`,
        "",
        "### For skill-specific experience (when a named skill was used):",
        `1. Read \`${join(basePath, "experience", "_index.json")}\``,
        `2. Append an entry to \`${join(basePath, "experience", "skill-[skill-id].md")}\` using this format:`,
        "```markdown",
        "## [Problem/Technique Title]",
        "**Date:** YYYY-MM-DD",
        "**Skill:** [skill-id]",
        "**Situation:** One-sentence description",
        "**Solution:**",
        "- Specific step 1",
        "- Specific step 2",
        "**Key Files/Paths:**",
        "- /path/to/file",
        "**Keywords:** keyword1, keyword2, keyword3",
        "```",
        `3. If the skill is new, add an entry to \`${join(basePath, "experience", "_index.json")}\` skills array`,
        `4. Update the \`count\` and \`lastUpdated\` fields`,
        "",
        "**Important:** Only record if the learning has genuine reuse value. Do not record trivial operations.",
    ].join("\n");
}
