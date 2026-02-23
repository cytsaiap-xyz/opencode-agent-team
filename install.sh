#!/bin/bash
set -e

# Agent Team Plugin Installer for OpenCode
# Usage: bash install.sh [project_dir]
#
# The plugin uses a config handler to programmatically register agents
# and disable built-in agents. No manual .md copying or opencode.json
# editing needed — everything is controlled by .opencode/agent-team.json.

PROJECT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_DIR="$PROJECT_DIR/.opencode"

# Detect package manager: prefer bun, fall back to npm
if command -v bun &> /dev/null; then
  PKG_MGR="bun"
  PKG_INSTALL="bun install --silent"
  PKG_ADD="bun add"
elif command -v npm &> /dev/null; then
  PKG_MGR="npm"
  PKG_INSTALL="npm install --silent"
  PKG_ADD="npm install"
else
  echo "ERROR: Neither bun nor npm found. Please install one of them first."
  exit 1
fi

echo "Installing agent-team plugin into: $PROJECT_DIR"
echo "  Using package manager: $PKG_MGR"

# 1. Create directories
mkdir -p "$OPENCODE_DIR/plugins"

# 2. Create plugin entry point
cat > "$OPENCODE_DIR/plugins/agent-team.ts" << 'EOF'
export { AgentTeamPlugin as default } from "../../agent-team/src/index.ts";
EOF
echo "  Created .opencode/plugins/agent-team.ts"

# 3. Create agent-team.json toggle config (if it doesn't already exist)
if [ ! -f "$OPENCODE_DIR/agent-team.json" ]; then
  cat > "$OPENCODE_DIR/agent-team.json" << 'EOF'
{
    "enabled": true,
    "verbose": false
}
EOF
  echo "  Created .opencode/agent-team.json (enabled)"
else
  echo "  .opencode/agent-team.json already exists — keeping current settings"
fi

# 4. Set up .opencode/package.json (merge if exists)
if [ -f "$OPENCODE_DIR/package.json" ]; then
  if ! grep -q '@opencode-ai/plugin' "$OPENCODE_DIR/package.json"; then
    cd "$OPENCODE_DIR" && $PKG_ADD @opencode-ai/plugin && cd - > /dev/null
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

# 5. Install dependencies
echo "  Installing dependencies..."
cd "$OPENCODE_DIR" && $PKG_INSTALL && cd - > /dev/null
cd "$SCRIPT_DIR" && $PKG_INSTALL && cd - > /dev/null

# 6. Verify critical dependency is installed
if [ ! -d "$SCRIPT_DIR/node_modules/@opencode-ai/plugin" ]; then
  echo ""
  echo "WARNING: @opencode-ai/plugin was not installed in $SCRIPT_DIR."
  echo "  Try running '$PKG_INSTALL' manually inside: $SCRIPT_DIR"
  exit 1
fi

echo ""
echo "Done! Restart OpenCode to activate the agent-team plugin."
echo ""
echo "To disable: set \"enabled\": false in .opencode/agent-team.json and restart."
