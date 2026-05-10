# large-cli VS Code Extension

A tiny VS Code extension that opens the large-cli Codex terminal UI in an integrated terminal.

## What it does

- Adds a command: `largeCli.open`
- Opens a new VS Code terminal named `large-cli`
- Runs the bundled `large-cli.js` terminal chat UI

## Development

Open this folder in VS Code and press F5 to run the extension in an Extension Development Host.

## Package

From this folder:

```bash
npm install
npm run package
```

## Notes

- The extension is self-contained: it bundles its own copy of the CLI entry script.
- The CLI still uses the Codex CLI backend.
- On Windows, the bundled CLI keeps the host-specific Codex launch logic.
