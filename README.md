# large-cli

A simple terminal chat UI for Codex CLI with a neon purple/blue look.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Or run the package directly after linking/publishing:

```bash
npm install -g .
large-cli
```

## Run on Termux / Android

Termux support is included for Android terminals with Node.js installed.

```bash
pkg update
pkg install nodejs git
npm install
npm start
```

One-command setup from the repo:

```bash
bash ./scripts/termux-install.sh
```

Launch shortcut:

```bash
bash ./scripts/termux-launch.sh
```

Or use the npm aliases:

```bash
npm run termux:install
npm run termux:start
```

Notes:
- The CLI detects Termux and shows a visible warning banner when running there.
- The CLI detects Termux and prefers your active shell when launching Codex.
- On Android, `codex` must be available in your PATH for the backend to work.
- If your Termux shell is not Bash, the app falls back to `sh`.

large-cli can pass local MCP server definitions to Codex from a project file.

Create one of these in the folder you launch from:
- `large-cli.mcp.json`
- `.large-cli.mcp.json`

Example shape:

```json
{
  "mcpServers": {
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time"]
    }
  }
}
```

Inside the app, run `/mcp` to see which servers were loaded.

## MCP marketplaces and plugins

Use these commands inside the TUI:

- `/mcp market` - shows the MCP Market usage hint
- `/plugin install <mcpmarket-url>` - installs a marketplace source from a listing page like `https://mcpmarket.com/server/minecraft-survival`
- `/plugin market add <source>` - same as install, but explicit
- `/plugin market upgrade [name]` - upgrades one marketplace or all
- `/plugin market remove <name>` - removes a marketplace

These commands proxy to the Codex CLI plugin marketplace manager.

## Scripts

```bash
npm run check
npm run preview
```

## Notes

- The UI is a terminal app, not a web app.
- It uses the Codex CLI as the backend AI.
- On Windows, the app uses the platform Codex launcher path that works on this host.
