# Agent Team Plugin for OpenCode

A plugin that replaces OpenCode's default agents with a dynamic team system. An **orchestrator** agent decomposes your task, designs a team of specialized agents on-the-fly, and delegates work to them sequentially — each with a custom system prompt and skills tailored to the task.

## How It Works

```
User Request
    │
    ▼
┌─────────────┐     plan_team        ┌──────────────┐
│ Orchestrator │ ──────────────────►  │ Team Planning │
│  (primary)   │     add_agent ×N    │ (staging)     │
│  read-only   │ ──────────────────► └──────────────┘
│              │     finalize_team          │
│              │ ──────────────────►  ┌─────▼────────┐
│              │                     │ Active Team   │
│              │     delegate_task   │ (in memory)   │
│              │ ──────────────────► └──────────────┘
│              │                           │
│              │                     ┌─────▼────────┐
│              │ ◄────────────────── │ Worker Agent  │
│              │      result         │ (subagent)    │
│              │                     │ + dynamic     │
│              │     disband_team    │   prompt      │
│              │ ──────────────────► └──────────────┘
└─────────────┘
```

1. **Orchestrator** receives the task (read-only — cannot write files or execute code)
2. Calls `plan_team` to start team planning
3. Calls `add_agent` for each specialized agent (flat string args — works with any model)
4. Calls `finalize_team` to lock in the team
5. Calls `delegate_task` for each agent **one at a time** — each call blocks until the agent finishes and returns results
6. Worker executes the task with full write permissions using a dynamically injected prompt
7. Orchestrator reviews results, then calls `disband_team`

## Quick Install

```bash
bash agent-team/install.sh /path/to/your-project
```

This creates the plugin entry point, config file, and installs dependencies. Restart OpenCode after running.

## Manual Installation

### 1. Create the plugin entry point

Create `.opencode/plugins/agent-team.ts`:

```typescript
export { AgentTeamPlugin as default } from "../../agent-team/src/index.ts";
```

### 2. Create the config file

Create `.opencode/agent-team.json`:

```json
{
    "enabled": true,
    "verbose": false
}
```

### 3. Set up dependencies

Make sure `.opencode/package.json` includes:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "latest"
  }
}
```

### 4. Install dependencies

```bash
cd .opencode && npm install
cd ../agent-team && npm install
```

### 5. Restart OpenCode

No need to copy `.md` files or edit `opencode.json` — the plugin's config handler registers agents and disables built-ins automatically.

## Configuration

All configuration is in `.opencode/agent-team.json`:

```json
{
    "enabled": true,
    "verbose": false
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the plugin. When disabled, built-in agents are restored and plugin tools are hidden. |
| `verbose` | `boolean` | `false` | Show `[agent-team]` debug logs in the chat window. Useful for troubleshooting. |

A reference config is included at [`agent-team.example.json`](agent-team.example.json).

### What happens when enabled

- Built-in agents (`plan`, `build`, `general`, `explore`) are **disabled**
- `orchestrator` (primary) and `worker` (subagent) agents are **registered**
- Plugin tools (`plan_team`, `add_agent`, `finalize_team`, `delegate_task`, etc.) are **exposed**
- Available skills are **injected** into the orchestrator's prompt

### What happens when disabled

- Built-in agents remain **active** (default OpenCode behavior)
- Plugin tools return **empty** (not visible)
- No agents are registered by the plugin

### To toggle

1. Edit `.opencode/agent-team.json` → set `"enabled": false` (or `true`)
2. Restart OpenCode

## Tools

The plugin provides six tools to the orchestrator:

| Tool | Description |
|------|-------------|
| `plan_team` | **Call first.** Start team planning with a task summary |
| `add_agent` | Add one agent to the team (flat string args — repeat per agent) |
| `finalize_team` | Lock in the team after all agents are added (requires 2+) |
| `delegate_task` | Delegate to one agent and **wait for completion**. Returns result. Call once per agent, sequentially. |
| `list_team` | List the current active team and their roles |
| `disband_team` | Clean up after all subtasks have completed |

### Tool argument details

**`plan_team`**
| Arg | Type | Description |
|-----|------|-------------|
| `task_summary` | string | High-level summary of the overall task |

**`add_agent`**
| Arg | Type | Description |
|-----|------|-------------|
| `id` | string | Unique agent ID in kebab-case (e.g. `auth-model-dev`) |
| `role` | string | One-line role description |
| `system_prompt` | string | Detailed instructions: file paths, function signatures, approach |
| `skills` | string | Comma-separated skill names, or `""` if none needed |
| `permissions` | string | Preset: `reader`, `writer`, or `full` |

**`delegate_task`**
| Arg | Type | Description |
|-----|------|-------------|
| `agent_id` | string | ID of the agent to delegate to |
| `task` | string | Short task instruction |

All arguments are simple strings — no nested arrays or objects. This ensures compatibility with any LLM model.

## Permission Presets

| Preset | Tools |
|--------|-------|
| `reader` | read, glob, grep, list |
| `writer` | read, write, edit, glob, grep, list, bash |
| `full` | read, write, edit, glob, grep, list, bash, subagent |

## Skills

The plugin auto-discovers skills from three locations:

| Location | Source | Priority |
|----------|--------|----------|
| `~/.config/opencode/skills/` | Global | Lowest |
| `.opencode/skills/` | Project-local | Medium |
| `.agents/skills/` | Universal (`npx skills add`) | Highest |

Each skill directory should contain a `SKILL.md` file. The orchestrator sees available skill names in its prompt and can assign them to agents via the `skills` field in `add_agent`. Skill content is automatically injected into the worker's prompt during delegation.

Install skills with:

```bash
npx skills add https://github.com/anthropics/skills --skill frontend-design
npx skills add https://github.com/vercel-labs/agent-skills --skill web-design-guidelines
```

## Project Structure

```
agent-team/
├── agents/
│   ├── orchestrator.md     # Primary agent definition (read-only, team manager)
│   └── worker.md           # Subagent definition (execution engine)
├── src/
│   ├── index.ts            # Plugin entry — tools, config handler, dispatch logic
│   ├── team-manager.ts     # In-memory team registry with staging area
│   ├── prompt-builder.ts   # AgentSpec type, permission resolver, prompt builder
│   ├── agent-defs.ts       # Parses agent .md frontmatter into AgentConfig
│   ├── config-loader.ts    # Reads .opencode/agent-team.json
│   └── skills-loader.ts    # Discovers and loads SKILL.md files
├── agent-team.example.json # Example config file
├── install.sh              # Automated installer
├── DEVELOPMENT_NOTES.md    # Technical implementation notes
├── package.json
├── tsconfig.json
└── README.md
```

In the target project:

```
your-project/
├── .opencode/
│   ├── agent-team.json     # Plugin config (enabled, verbose)
│   ├── plugins/
│   │   └── agent-team.ts   # Plugin entry point (re-exports from agent-team/src/)
│   └── package.json        # Dependencies (@opencode-ai/plugin)
└── ...
```

## Example

Given the prompt "Add user authentication with JWT":

1. Orchestrator calls `plan_team("Add JWT authentication")`
2. Calls `add_agent` for each specialist:
   - `auth-model-dev` — creates User model and validation
   - `auth-api-dev` — creates login/register API endpoints
   - `auth-test-dev` — writes tests for auth flow
3. Calls `finalize_team`
4. Calls `delegate_task` for `auth-model-dev` → waits → gets result
5. Calls `delegate_task` for `auth-api-dev` → waits → gets result
6. Calls `delegate_task` for `auth-test-dev` → waits → gets result
7. Reviews all results, calls `disband_team`

Each subtask runs as a visible session (Ctrl+X to monitor).

## How It Works Under the Hood

- **No hot-reload needed**: Agent definitions live in the plugin package (`agents/*.md`), registered via the config handler at startup. No files need to be copied to `.opencode/agents/`.
- **Dynamic agents via static worker**: The `worker` agent is a generic executor. Each delegation injects a custom prompt (role + system_prompt + skills) into the `SubtaskPartInput`, effectively creating a different "agent" each time.
- **Sequential blocking**: `delegate_task` dispatches via `SubtaskPartInput` (visible in UI), then discovers the new session by diffing `session.status()`, polls until idle, and extracts results from `session.messages()`.
- **Multi-model compatible**: All tool arguments are flat strings — no nested JSON structures that weaker models struggle with.

## Limitations

- **Agents are not hot-reloaded**: OpenCode loads agents at startup only. The plugin works around this by injecting dynamic prompts into the static `worker` agent.
- **Sequential only**: Subtasks run one at a time. Parallel delegation was removed for reliability.
- **10-minute timeout**: Each `delegate_task` polls for up to 10 minutes before timing out.
- **Model dependency**: The orchestrator's effectiveness depends on the LLM's ability to follow tool-calling instructions and write good system prompts.

## License

MIT
