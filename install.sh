#!/bin/bash
set -e

# Agent Team Plugin Installer for OpenCode
# Usage: bash install.sh [project_dir]

PROJECT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_DIR="$PROJECT_DIR/.opencode"

echo "Installing agent-team plugin into: $PROJECT_DIR"

# 1. Create directories
mkdir -p "$OPENCODE_DIR/agents" "$OPENCODE_DIR/plugins"

# 2. Copy agent definitions
cp "$SCRIPT_DIR/agents/orchestrator.md" "$OPENCODE_DIR/agents/orchestrator.md"
cp "$SCRIPT_DIR/agents/worker.md" "$OPENCODE_DIR/agents/worker.md"
echo "  Copied orchestrator.md and worker.md to .opencode/agents/"

# 3. Create plugin entry point
cat > "$OPENCODE_DIR/plugins/agent-team.ts" << 'EOF'
export { AgentTeamPlugin as default } from "../../agent-team/src/index.ts";
EOF
echo "  Created .opencode/plugins/agent-team.ts"

# 4. Set up .opencode/package.json (merge if exists)
if [ -f "$OPENCODE_DIR/package.json" ]; then
  # Add dependency if not already present
  if ! grep -q '@opencode-ai/plugin' "$OPENCODE_DIR/package.json"; then
    cd "$OPENCODE_DIR" && bun add @opencode-ai/plugin && cd - > /dev/null
    echo "  Added @opencode-ai/plugin to .opencode/package.json"
  else
    echo "  .opencode/package.json already has @opencode-ai/plugin"
  fi
else
  cat > "$OPENCODE_DIR/package.json" << 'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "latest"
  }
}
EOF
  echo "  Created .opencode/package.json"
fi

# 5. Update opencode.json to disable default agents
OPENCODE_JSON="$PROJECT_DIR/opencode.json"
if [ -f "$OPENCODE_JSON" ]; then
  # Check if agent config already exists
  if grep -q '"agent"' "$OPENCODE_JSON"; then
    echo "  opencode.json already has agent config — please manually ensure these are disabled:"
    echo "    plan, build, general, explore"
  else
    # Insert agent config after the first {
    TMP=$(mktemp)
    sed '1s/{/{\"agent\":{\"plan\":{\"disable\":true},\"build\":{\"disable\":true},\"general\":{\"disable\":true},\"explore\":{\"disable\":true}},/' "$OPENCODE_JSON" > "$TMP"
    # Re-format with bun/node if available
    if command -v bun &> /dev/null; then
      bun -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('$TMP','utf8'));fs.writeFileSync('$OPENCODE_JSON',JSON.stringify(j,null,4)+'\n')" 2>/dev/null || mv "$TMP" "$OPENCODE_JSON"
    else
      mv "$TMP" "$OPENCODE_JSON"
    fi
    rm -f "$TMP"
    echo "  Updated opencode.json — disabled default agents"
  fi
else
  cat > "$OPENCODE_JSON" << 'EOF'
{
    "$schema": "https://opencode.ai/config.json",
    "agent": {
        "plan":    { "disable": true },
        "build":   { "disable": true },
        "general": { "disable": true },
        "explore": { "disable": true }
    }
}
EOF
  echo "  Created opencode.json with default agents disabled"
fi

# 6. Install dependencies
echo "  Installing dependencies..."
cd "$OPENCODE_DIR" && bun install --silent && cd - > /dev/null
cd "$SCRIPT_DIR" && bun install --silent && cd - > /dev/null

echo ""
echo "Done! Restart OpenCode to activate the agent-team plugin."
