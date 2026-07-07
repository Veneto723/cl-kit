#!/usr/bin/env bash
# cl-kit installer (Linux / macOS). Deploys the cl account switcher into ~/.claude
# and ~/.local/bin, wires hooks + statusline into settings.json (merging, never
# clobbering). Re-runnable. The Windows-only extras (desktop toasts, click-to-focus,
# DPAPI) are simply skipped — the core (switching, per-account credential isolation,
# usage, trash, zero-token cl: commands) is fully cross-platform.
#
#   bash install.sh
set -euo pipefail

kit="$(cd "$(dirname "$0")" && pwd)"
claude_dir="$HOME/.claude"
scripts="$claude_dir/scripts"
commands="$claude_dir/commands"
bin="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }
say "cl-kit installer ($(uname -s))"

command -v node >/dev/null 2>&1 || { echo "Node.js is required on PATH." >&2; exit 1; }
has_claude=0; command -v claude >/dev/null 2>&1 && has_claude=1
if [ "$has_claude" -eq 0 ]; then
  say "  ! 'claude' CLI not found on PATH — install Claude Code first (https://claude.com/claude-code)."
  say "    Continuing; the cl MCP server registration will be skipped."
fi

# 1. scripts (JS only — the .ps1/.vbs/icon helpers are Windows-only, skipped)
mkdir -p "$scripts" "$commands" "$bin"
cp "$kit"/src/*.js "$scripts"/
cp "$kit"/pool/*.js "$scripts"/ 2>/dev/null || true
say "  scripts -> $scripts"

# 2. cl MCP server (account management + pool metrics tools)
mcp_dest="$scripts/cl-mcp"
mkdir -p "$mcp_dest"
cp "$kit"/mcp/server.js "$mcp_dest"/
cp "$kit"/mcp/package.json "$mcp_dest"/
if [ ! -d "$mcp_dest/node_modules" ]; then
  ( cd "$mcp_dest" && npm install --silent >/dev/null 2>&1 ) || say "  ! npm install for cl-mcp failed (the switcher still works; MCP tools need deps)"
fi
if [ "$has_claude" -eq 1 ]; then
  claude mcp remove --scope user cl >/dev/null 2>&1 || true
  claude mcp add --scope user cl node "$mcp_dest/server.js" >/dev/null 2>&1 || true
  say "  cl MCP server installed + registered (account_* / config_update / pool_* tools)"
else
  say "  cl MCP server installed (register later: claude mcp add --scope user cl node \"$mcp_dest/server.js\")"
fi

# 3. launcher: ~/.local/bin/cl
cat > "$bin/cl" <<EOF
#!/bin/sh
exec node "\$HOME/.claude/scripts/cl-runner.js" "\$@"
EOF
chmod +x "$bin/cl"
if printf '%s' ":$PATH:" | grep -q ":$bin:"; then
  say "  cl -> $bin  (already on PATH)"
else
  say "  cl -> $bin  (NOT on PATH — add it, e.g.:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc  then open a new shell)"
fi

# 4. slash commands
cp "$kit"/commands/*.md "$commands"/ 2>/dev/null || true
say "  commands -> $commands (/switch /restart /cl)"

# 5. settings.json: hooks + statusline + switch allow-rule (shared Node wiring)
node "$scripts/cl-wire-settings.js" "$scripts"

say ""
say "Done. Next:"
say "  cl setup    # choose your account style"
say "  cl doctor   # verify"
say "  cl          # launch"
say ""
say "Note: desktop toasts + click-to-focus and DPAPI key encryption are Windows-only."
say "      On Linux/macOS, gateway keys are stored via 'cl set-key' (0600 file) or apiKeyEnv/apiKeyFrom."
