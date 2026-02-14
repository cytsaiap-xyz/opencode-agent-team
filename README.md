# Agent Team Plugin for OpenCode

A plugin that replaces OpenCode's default agents with a dynamic team system. An **orchestrator** agent analyzes your task, designs a team of specialized agents on-the-fly, and delegates work to them — each with a custom system prompt tailored to the task.

## How It Works

```
User Request
    │
    ▼
┌─────────────┐     build_team      ┌──────────────┐
│ Orchestrator │ ──────────────────► │ Agent Specs   │
│  (primary)   │                     │ stored in mem │
│  read-only   │     delegate_task   └──────────────┘
│              │ ──────────────────► ┌──────────────┐
│              │                     │ Worker Agent  │
│              │ ◄────────────────── │ (subagent)    │
│              │      result         │ + custom      │
│              │                     │   system      │
│              │     disband_team    │   prompt      │
│              │ ──────────────────► └──────────────┘
└─────────────┘
```

1. **Orchestrator** receives the task and analyzes it (read-only — cannot write files)
2. Calls `build_team` to define specialized agents with custom system prompts
3. Calls `delegate_task` for each agent — creates a child session using the **worker** subagent with a dynamic system prompt override
4. Worker executes the task with full write permissions
5. Orchestrator reports results and calls `disband_team`

The worker agent is a single pre-built subagent that acts as the execution engine. Its behavior changes per delegation via the `system` prompt parameter — effectively creating a different "agent" each time.

## Quick Install

```bash
bash agent-team/install.sh /path/to/your-project
```

This handles everything: copies agent files, creates the plugin entry point, updates `opencode.json`, and installs dependencies. Restart OpenCode after running.

## Manual Installation

### 1. Copy agent files

Copy the agent definitions into your project's `.opencode/agents/` directory:

```
.opencode/agents/orchestrator.md   # Primary agent (read-only, designs teams)
.opencode/agents/worker.md         # Subagent (write permissions, execution engine)
```

### 2. Install the plugin

Create `.opencode/plugins/agent-team.ts`:

```typescript
export { AgentTeamPlugin as default } from "../../agent-team/src/index.ts";
```

Make sure `.opencode/package.json` includes the dependency:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "latest"
  }
}
```

### 3. Disable default agents

In your `opencode.json`, disable the built-in agents so only the orchestrator is active:

```json
{
  "agent": {
    "plan":    { "disable": true },
    "build":   { "disable": true },
    "general": { "disable": true },
    "explore": { "disable": true }
  }
}
```

### 4. Install dependencies

```bash
cd .opencode && bun install
cd ../agent-team && bun install
```

## Tools

The plugin provides four tools to the orchestrator:

| Tool | Description |
|------|-------------|
| `build_team` | Define a team of agents with custom IDs, roles, system prompts, and permission presets |
| `delegate_task` | Send a task to an agent — creates a child session with the agent's system prompt |
| `list_team` | List the current active team and their roles |
| `disband_team` | Clean up the team when work is complete |

## Permission Presets

When defining agents in `build_team`, use these presets for the `permissions` field:

| Preset | Tools |
|--------|-------|
| `reader` | read, glob, grep, list |
| `writer` | read, write, edit, glob, grep, list, bash |
| `full` | read, write, edit, glob, grep, list, bash, subagent |

## Project Structure

```
agent-team/
├── src/
│   ├── index.ts           # Plugin entry — defines build_team, delegate_task, list_team, disband_team
│   ├── team-manager.ts    # Manages agent specs and team lifecycle
│   └── prompt-builder.ts  # AgentSpec type and markdown generation
├── package.json
├── tsconfig.json
└── README.md

.opencode/
├── agents/
│   ├── orchestrator.md    # Primary agent — analyzes tasks, builds teams, delegates
│   └── worker.md          # Subagent — executes delegated tasks with write permissions
├── plugins/
│   └── agent-team.ts      # Plugin entry point (re-exports from agent-team/src/)
└── package.json
```

## Example

Given the prompt "Create a file called hello.txt with content 'Hello World'", the orchestrator will:

1. Call `build_team` with a `file-creator` agent spec
2. Call `delegate_task` — a child session runs with the custom system prompt and creates the file
3. Call `disband_team` to clean up

## Configuration

Defaults are defined in `src/index.ts`:

- **Max team size**: 6 agents per team
- **Permission presets**: `reader`, `writer`, `full` (see table above)

## Limitations

- **Agents are not hot-reloaded**: OpenCode loads agent `.md` files at startup only. The plugin works around this by using a single `worker.md` agent with dynamic system prompt overrides via the SDK.
- **Polling timeout**: `delegate_task` polls for up to 30 seconds. Long-running tasks may return before the child session finishes, but the work continues in the background.
- **Model dependency**: The orchestrator's effectiveness depends on the LLM's ability to follow tool-calling instructions. Stronger models produce better agent designs and more reliable delegation.

## License

MIT
