# Agent-Team Plugin — Development Notes

Technical notes on the methods, workarounds, and patterns used to build this plugin.

---

## Table of Contents

1. [One-File Enable/Disable via Config Handler](#1-one-file-enabledisable-via-config-handler)
2. [Dynamic Agents Without Hot-Reload](#2-dynamic-agents-without-hot-reload)
3. [Locking Down the Orchestrator](#3-locking-down-the-orchestrator)
4. [Skills Injection at Config Time](#4-skills-injection-at-config-time)
5. [Sequential Delegation with UI Visibility](#5-sequential-delegation-with-ui-visibility)
6. [Avoiding Startup Deadlocks](#6-avoiding-startup-deadlocks)
7. [Controlling Plugin Log Output](#7-controlling-plugin-log-output)
8. [Flat Tool Schema for Multi-Model Compatibility](#8-flat-tool-schema-for-multi-model-compatibility)
9. [Key SDK Methods Used](#9-key-sdk-methods-used)
10. [Pitfalls and Lessons Learned](#10-pitfalls-and-lessons-learned)

---

## 1. One-File Enable/Disable via Config Handler

**Problem**: Toggling the plugin previously required 3 manual steps — copying `.md` files, editing `opencode.json`, and managing the plugin entry point.

**Solution**: Use the plugin `config` handler (`config?: (input: Config) => Promise<void>`) to programmatically control everything from a single file: `.opencode/agent-team.json`.

```json
{ "enabled": true, "verbose": false }
```

**How it works** (`src/index.ts` config handler):

- **When enabled**: Disables built-in agents (`plan`, `build`, `general`, `explore`) by setting `config.agent[name].disable = true`, then registers `orchestrator` and `worker` agents via `config.agent`.
- **When disabled**: Returns early — config is untouched, built-ins stay active. Tools return an empty object `{}` so no plugin tools appear.

```typescript
config: async (config) => {
    if (!pluginConfig.enabled) return;
    config.agent = config.agent ?? {};
    for (const name of ["plan", "build", "general", "explore"]) {
        config.agent[name] = { ...config.agent[name], disable: true };
    }
    for (const [name, def] of Object.entries(agentDefs)) {
        config.agent[name] = { ...def, ...config.agent[name] };
    }
}
```

**Key detail**: Agent definitions are parsed from `agents/*.md` files in the plugin package directory (not `.opencode/agents/`) via `src/agent-defs.ts`. This means no `.md` files need to be copied into the user's project — the plugin carries its own agent definitions.

**Gotcha**: If old `.opencode/agents/orchestrator.md` or `worker.md` files exist from a previous install, OpenCode's filesystem agent discovery will load them regardless of the plugin state. Delete those leftover files.

---

## 2. Dynamic Agents Without Hot-Reload

**Problem**: OpenCode loads agent `.md` files at startup only — no hot-reload. The orchestrator needs to create different specialized agents per task at runtime.

**Solution**: Use a single static `worker` agent as the execution engine. At dispatch time, inject a dynamic system prompt into the subtask that includes the agent's custom identity, instructions, and skills.

```
┌─────────────────┐                    ┌──────────────────┐
│   Orchestrator   │  delegate_task     │   Worker Agent   │
│  (build_team     │ ────────────────►  │  (static .md)    │
│   creates specs  │  SubtaskPartInput  │                  │
│   in memory)     │  with dynamic      │  Receives custom │
│                  │  prompt injected   │  prompt at each  │
│                  │  via worker agent  │  dispatch         │
└─────────────────┘                    └──────────────────┘
```

**Implementation** (`src/prompt-builder.ts`):

`buildDelegationPrompt()` constructs a full markdown prompt:
```
# Your Role: <agent role>
<system_prompt from build_team>
# Relevant Skills
<injected skill content>
# Task
<short task instruction>
```

This is sent as the `prompt` field in `SubtaskPartInput` with `agent: "worker"`. The worker's own `.md` just says "follow instructions" — the real behavior comes from the injected prompt.

**Why not `session.create()` + `agent: "worker"`?**: Creating standalone sessions makes them invisible in OpenCode's Ctrl+X subtask viewer. `SubtaskPartInput` on the parent session creates proper subtask sessions that appear in the UI.

---

## 3. Locking Down the Orchestrator

**Problem**: The orchestrator LLM would try to read/write files itself instead of delegating.

**Solution**: Two layers of permission denial in `agents/orchestrator.md` frontmatter:

**Layer 1 — Tool booleans** (prevents tool from appearing):
```yaml
tools:
  read: false
  write: false
  edit: false
  glob: false
  grep: false
  bash: false
  list: false
  webfetch: false
  subagent: false
```

**Layer 2 — Permission blocks** (hard deny even if tools leak through):
```yaml
permission:
  edit: deny
  bash: deny
  webfetch: deny
  external_directory: deny
```

**Parsing** (`src/agent-defs.ts`): A custom frontmatter parser handles the nested `tools:` and `permission:` YAML blocks since they aren't standard key-value pairs. The parser detects indented lines under block headers.

**Key detail**: Both `list` and `webfetch` must be explicitly set to `false`. Missing entries default to the agent's base permissions, which can allow read-like operations.

---

## 4. Skills Injection at Config Time

**Problem**: The orchestrator needs to know what skills are available to assign to agents, but it can't read the filesystem.

**Solution**: Load skills at plugin init time and inject the list into the orchestrator's prompt via the config handler.

**Skill locations scanned** (`src/skills-loader.ts`):
1. `~/.config/opencode/skills/` — global skills
2. `.opencode/skills/` — project-local skills
3. `.agents/skills/` — universal agent skills (where `npx skills add` installs)

Each skill directory contains a `SKILL.md` with optional frontmatter (`name`, `description`) and body content.

**Injection**: During the config handler, if skills exist, an `## Available Skills` section is appended to the orchestrator's prompt listing each skill name and description. When `delegate_task` is called, the skill's full content is injected into the worker's prompt via `buildSkillContext()`.

---

## 5. Sequential Delegation with UI Visibility

**Problem**: The orchestrator calls `delegate_task` for all agents in a single response (parallel tool calls). Even with blocking tool execution, the LLM sends all calls at once.

**Solution**: Three-layer enforcement:

### Layer A — Orchestrator prompt

The prompt explicitly states: "You MUST call `delegate_task` exactly ONCE per message." with a numbered sequence showing the expected pattern.

### Layer B — Code-level lock

A `delegationInProgress` boolean rejects concurrent calls:
```typescript
if (delegationInProgress) {
    return "ERROR: Another delegation is already in progress...";
}
delegationInProgress = true;
try { ... } finally { delegationInProgress = false; }
```

### Layer C — Blocking dispatch with session tracking

`dispatchSubtask()` uses `SubtaskPartInput` for UI visibility, then discovers and polls the subtask session:

```
1. Snapshot existing session IDs       → session.status()
2. Dispatch via SubtaskPartInput       → session.promptAsync() on parent session
3. Discover new session ID             → diff session.status() against snapshot
4. Poll until idle                     → session.status() every 3s, up to 10min
5. Extract result                      → session.messages() on subtask session
6. Return result text to orchestrator
```

**Session discovery**: After dispatching, poll `session.status()` every 2 seconds and look for a session ID that wasn't in the pre-dispatch snapshot. This works because the delegation lock prevents concurrent dispatches.

**Why not `session.create()`?**: Sessions created via `session.create()` don't appear as subtasks in OpenCode's Ctrl+X UI. Only `SubtaskPartInput` creates proper visible subtask sessions.

**Why not event-based discovery?**: The `session.created` event captures the first session as the parent. Whether subtask sessions also fire this event is uncertain, so status-diffing is more reliable.

---

## 6. Avoiding Startup Deadlocks

**Problem**: Calling `client.tool.ids()` or any server API during plugin init or the config handler causes OpenCode to hang — the server isn't fully ready yet because the config handler hasn't returned.

**Solution**: Only call server APIs in event handlers (after startup completes) or in tool execution functions (triggered by user interaction).

```typescript
// WRONG — deadlocks during init
const AgentTeamPlugin: Plugin = async (ctx) => {
    const tools = await ctx.client.tool.ids(); // hangs forever
};

// RIGHT — capture session ID in event handler
event: async ({ event }) => {
    if (event.type === "session.created") {
        parentSessionId = props.info.id; // safe, server is running
    }
}
```

Skills loading via filesystem (`readdir`/`readFile`) is safe during init since it doesn't hit the server.

---

## 7. Controlling Plugin Log Output

**Problem**: `console.log` in plugins appears in the OpenCode chat window alongside user messages.

**Solution**: Gate all logging behind a `verbose` config flag read from `.opencode/agent-team.json`:

```typescript
const log = (...args: unknown[]) => {
    if (pluginConfig.verbose) console.log("[agent-team]", ...args);
};
```

Set `"verbose": true` in `agent-team.json` for debug output. Default is `false` (silent).

---

## 8. Flat Tool Schema for Multi-Model Compatibility

**Problem**: The original `build_team` tool required a deeply nested schema — an array of objects, each with 5 fields (including nested arrays for `skills` and `permissions`). Weaker LLMs (non-Opus/Sonnet models) frequently fail to produce valid JSON for this structure, causing JSON parsing errors.

**Root cause**: LLM tool-calling reliability degrades sharply with schema complexity. Nested `array(object({...array(string())...}))` is the worst case — models must produce valid JSON with correct nesting, bracket matching, and comma placement across many levels.

**Solution**: Decompose the single complex tool into three flat tools with only string arguments:

| Before (1 complex tool) | After (3 flat tools) |
|---|---|
| `build_team(task_summary, agents: [{id, role, system_prompt, skills: [], permissions: []}])` | `plan_team(task_summary)` |
| | `add_agent(id, role, system_prompt, skills, permissions)` |
| | `finalize_team()` |

**Key changes**:
- `skills` changed from `string[]` to comma-separated `string` (e.g. `"web-design,frontend-design"` or `""`)
- `permissions` changed from `string[]` to single `string` (e.g. `"writer"`)
- `add_agent` is called once per agent with flat args — no nesting at all
- `finalize_team` validates minimum 2 agents and activates the team

**Implementation** (`src/team-manager.ts`):

TeamManager uses a staging area pattern:
```
startTeam()     → sets pendingTaskSummary, clears pendingAgents[]
addAgent(spec)  → validates & pushes to pendingAgents[]
finalizeTeam()  → validates >= 2, creates activeTeam, clears staging
```

**Why this works**: Every tool argument is a simple `string`. No arrays, no objects, no nesting. Even the weakest tool-calling models can produce `{"id": "auth-dev", "role": "...", "system_prompt": "...", "skills": "", "permissions": "writer"}` reliably.

**Trade-off**: More tool calls needed (plan + N×add_agent + finalize vs 1×build_team), but reliability across models is far more important than call count.

---

## 9. Key SDK Methods Used

| Method | Signature | Returns | Used For |
|--------|-----------|---------|----------|
| `session.create()` | `body: { parentID?, title? }, query: { directory? }` | `{ data: Session }` with `id`, `projectID`, etc. | Creating standalone sessions (not used in final approach) |
| `session.promptAsync()` | `path: { id }, body: { parts, agent? }` | `void` (204) | Dispatching subtasks via `SubtaskPartInput` |
| `session.status()` | `query: { directory? }` | `{ [sessionId]: { type: "idle" \| "busy" \| "retry" } }` | Polling subtask completion, discovering new sessions |
| `session.messages()` | `path: { id }, query: { directory?, limit? }` | `Array<{ info: Message, parts: Part[] }>` | Extracting subtask results |

### Part Input Types for `promptAsync`

| Type | Fields | Purpose |
|------|--------|---------|
| `TextPartInput` | `type: "text", text: string` | Send text prompt to a session |
| `SubtaskPartInput` | `type: "subtask", prompt, description, agent` | Create a visible subtask session |
| `FilePartInput` | `type: "file", mime, url` | Attach files |
| `AgentPartInput` | `type: "agent", name` | Switch agent mode |

### SDK Result Pattern

All SDK methods return `Promise<{ data, error, request, response }>`. Check `result.error` before using `result.data`. Types are generic and often need casting:
```typescript
const statusMap = statusResult.data as Record<string, { type: string }>;
```

---

## 10. Pitfalls and Lessons Learned

### `session.prompt()` blocks forever
Use `session.promptAsync()` + poll `session.status()` instead. The synchronous `prompt()` never returns in a plugin context.

### Agent type must be pre-registered
`SubtaskPartInput.agent` must be a known agent (registered at startup). Using a dynamic name like `"auth-model-dev"` causes `Unknown agent type` error. Always use `agent: "worker"`.

### Config handler runs before server is ready
No server API calls (`client.tool.*`, `client.session.*`) in the config handler or plugin init. Use event handlers or tool execution instead.

### Leftover `.opencode/agents/*.md` files override plugin
If old agent `.md` files exist in `.opencode/agents/`, OpenCode loads them via filesystem discovery regardless of the plugin. Delete them after migrating to the config handler approach.

### LLMs make parallel tool calls by default
Even with blocking tool execution, the LLM sends all tool calls in a single response. Must enforce sequential behavior at both prompt level ("ONE call per message") and code level (delegation lock).

### `console.log` shows in chat
Plugin stdout goes to the OpenCode UI. Gate all logging behind a config flag to keep the chat clean.

### Skill directories vary by install method
- `npx skills add` installs to `.agents/skills/`
- Manual placement goes in `.opencode/skills/`
- Global skills are at `~/.config/opencode/skills/`

Scan all three locations.

### Complex tool schemas break weaker models
Nested `array(object({...}))` schemas cause JSON parsing failures on non-frontier models. Decompose into multiple flat-argument tools. Every argument should be a simple `string` or `number` — never nested arrays or objects.

### `import.meta.url` for package-relative paths
Use `new URL("..", import.meta.url).pathname` to resolve the plugin package root directory for reading bundled agent `.md` files. This works regardless of where the project is located.
