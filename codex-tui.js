#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const process = require('process');

const state = {
  messages: [],
  draft: '',
  busy: false,
  frame: 0,
  child: null,
  tempFile: null,
};

const isWin = process.platform === 'win32';
const isTermux = !!process.env.TERMUX_VERSION || /\btermux\b/i.test(process.env.PREFIX || '');
const ESC = '\u001b[';
const THEME = {
  title: '1;38;5;99',
  subtitle: '2;38;5;135',
  accent: '38;5;117',
  accentSoft: '38;5;93',
  accentAlt: '38;5;141',
  text: '38;5;252',
  muted: '2;38;5;245',
  prompt: '38;5;99',
  promptBusy: '38;5;135',
  user: '38;5;117',
  assistant: '38;5;141',
  line: '2;38;5;237',
};
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function c(code, text = '') {
  return `${ESC}${code}m${text}${ESC}0m`;
}

function ansi(code) {
  return `${ESC}${code}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function timeLabel(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function cwdLabel() {
  return process.cwd().replace(/^[A-Z]:/i, (m) => m.toLowerCase());
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function centerLine(text, targetWidth) {
  const visible = stripAnsi(text);
  const padLeft = Math.max(0, Math.floor((targetWidth - visible.length) / 2));
  const padRight = Math.max(0, targetWidth - visible.length - padLeft);
  return `${' '.repeat(padLeft)}${text}${' '.repeat(padRight)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function hideCursor() {
  process.stdout.write(ansi('?25l'));
}

function showCursor() {
  process.stdout.write(ansi('?25h'));
}

function clearScreen() {
  process.stdout.write(ansi('3J') + ansi('2J') + ansi('H'));
}

function moveTo(row, col) {
  process.stdout.write(ansi(`${row};${col}H`));
}

function wrapText(text, width) {
  if (width <= 0) return [''];
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      out.push('');
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

function renderMessage(message, width) {
  const isUser = message.role === 'user';
  const label = isUser ? 'you' : 'codex';
  const marker = isUser ? c(THEME.user, '›') : c(THEME.assistant, '•');
  const header = `${marker} ${c(THEME.muted, label)} ${c(THEME.muted, timeLabel(message.time))}`;
  const lines = wrapText(message.text, Math.max(12, width - 2)).map((line) => `  ${c(THEME.text, line)}`);
  return [header, ...lines, ''];
}

function buildBanner(width) {
  const art = [
    '██╗      █████╗ ██████╗  ██████╗ ███████╗     ██████╗██╗     ██╗',
    '██║     ██╔══██╗██╔══██╗██╔════╝ ██╔════╝    ██╔════╝██║     ██║',
    '██║     ███████║██████╔╝██║  ███╗█████╗█████╗██║     ██║     ██║',
    '██║     ██╔══██║██╔══██╗██║   ██║██╔══╝╚════╝██║     ██║     ██║',
    '███████╗██║  ██║██║  ██║╚██████╔╝███████╗    ╚██████╗███████╗██║',
    '╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝     ╚═════╝╚══════╝╚═╝',
  ];
  const gradient = ['93', '99', '105', '111', '135', '141', '147'];
  return art.map((line, index) => c(`1;38;5;${gradient[index % gradient.length]}`, line.slice(0, width)));
}

function buildConversationPrompt(userText) {
  const recent = state.messages.slice(-12).filter((message) => !(message.role === 'user' && message.text === userText));
  const transcript = recent
    .map((message) => {
      const prefix = message.role === 'user' ? 'User' : 'Assistant';
      return `${prefix}: ${message.text}`;
    })
    .join('\n');

  return [
    'You are Codex running inside a terminal chat UI named LARGE-CLI.',
    'Be helpful, concise, and concrete.',
    'If the user asks for code, provide the code first and keep explanation short unless asked otherwise.',
    '',
    'Conversation so far:',
    transcript,
    'User: ' + userText,
    'Assistant:',
  ].join('\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function cmdQuote(value) {
  return String(value);
}

function codexCommand(tempFile, mcpOverrides = []) {
  const binary = isWin ? 'codex.cmd' : 'codex';
  const quote = isWin ? cmdQuote : shellQuote;
  const configArgs = mcpOverrides.flatMap((override) => ['-c', override]);
  return [
    binary,
    ...configArgs,
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-last-message',
    quote(tempFile),
  ].join(' ');
}

function trustStorePath() {
  return path.join(os.homedir(), '.large-cli-trusted-folders.json');
}

function sanitizeMcpName(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, '_');
}

function isMcpMarketServerUrl(value) {
  return /^https?:\/\/(?:www\.)?mcpmarket\.com\/server\/[A-Za-z0-9_-]+(?:[?#].*)?$/i.test(String(value).trim());
}

function normalizeMcpMarketSource(value) {
  const raw = String(value).trim();
  if (/^(?:https?:\/\/)?(?:www\.)?mcpmarket\.com\/server\/[A-Za-z0-9_-]+(?:[?#].*)?$/i.test(raw)) {
    return raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw.replace(/^\/+/, '')}`;
  }
  return raw;
}

function mcpMarketSlug(value) {
  const match = String(value).match(/mcpmarket\.com\/server\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : '';
}

function titleFromSlug(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function tomlEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tomlValue(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'string') return `"${tomlEscape(value)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => tomlValue(entry)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${key}=${tomlValue(entry)}`)
      .join(',')}}`;
  }
  return `"${tomlEscape(value)}"`;
}

function localMcpConfigPaths() {
  return [
    path.join(process.cwd(), 'large-cli.mcp.json'),
    path.join(process.cwd(), '.large-cli.mcp.json'),
  ];
}

function loadLocalMcpServers() {
  for (const file of localMcpConfigPaths()) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      const servers = parsed && (parsed.mcpServers || parsed.mcp_servers || parsed.servers);
      if (servers && typeof servers === 'object') return servers;
    } catch {
      // ignore malformed config files
    }
  }
  return {};
}

function mcpOverridesFromServers(servers) {
  return Object.entries(servers)
    .map(([name, server]) => {
      if (!server || typeof server !== 'object') return null;
      const normalized = sanitizeMcpName(name);
      const config = {};
      for (const key of ['command', 'args', 'env', 'url', 'headers', 'timeout', 'connect_timeout', 'bearer_token_env_var']) {
        if (server[key] !== undefined) config[key] = server[key];
      }
      if (!Object.keys(config).length) return null;
      return `mcp_servers.${normalized}=${tomlValue(config)}`;
    })
    .filter(Boolean);
}

function normalizeFolder(folder) {
  try {
    const resolved = fs.realpathSync(folder).replace(/[\\/]+$/, '');
    return isWin ? resolved.toLowerCase() : resolved;
  } catch {
    const resolved = path.resolve(folder).replace(/[\\/]+$/, '');
    return isWin ? resolved.toLowerCase() : resolved;
  }
}

function loadTrustedFolders() {
  try {
    const raw = fs.readFileSync(trustStorePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map((entry) => normalizeFolder(entry)));
  } catch {
    // ignore missing or invalid trust store
  }
  return new Set();
}

function saveTrustedFolders(folders) {
  try {
    fs.writeFileSync(trustStorePath(), JSON.stringify([...folders].sort(), null, 2));
  } catch {
    // ignore trust store write failures
  }
}

function isTrustedFolder(folder) {
  return loadTrustedFolders().has(normalizeFolder(folder));
}

function renderTrustWarning(folder) {
  const width = Math.max(40, process.stdout.columns || 80);
  const lines = [
    '',
    centerLine(c('1;38;5;135', 'Warning: untrusted folder'), width),
    '',
    centerLine(c(THEME.text, `Folder: ${folder}`.slice(0, width)), width),
    '',
    centerLine(c(THEME.muted, 'Do you trust the owner of this folder?'), width),
    centerLine(c(THEME.muted, 'Press y to trust and continue, or n to exit.'), width),
    '',
  ];
  return [
    ...Array.from({ length: Math.max(0, Math.floor((Math.max(12, process.stdout.rows || 24) - lines.length) / 2)) }, () => ''),
    ...lines,
  ].join('\n');
}

function promptTrustWarning(folder) {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  if (isTrustedFolder(folder)) return Promise.resolve(true);

  return new Promise((resolve) => {
    const normalized = normalizeFolder(folder);
    const onKey = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        shutdown();
        return;
      }

      const value = String(str || '').trim().toLowerCase();
      if (value === 'y' || value === 'yes') {
        const trusted = loadTrustedFolders();
        trusted.add(normalized);
        saveTrustedFolders(trusted);
        process.stdin.off('keypress', onKey);
        resolve(true);
        return;
      }

      if (value === 'n' || value === 'no' || key?.name === 'escape' || key?.name === 'return') {
        process.stdin.off('keypress', onKey);
        resolve(false);
      }
    };

    clearScreen();
    showCursor();
    process.stdout.write(renderTrustWarning(folder));
    process.stdin.setEncoding('utf8');
    readline.emitKeypressEvents(process.stdin);
    try { process.stdin.setRawMode(true); } catch {}
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
  });
}

function buildScreen() {
  const width = Math.max(40, process.stdout.columns || 80);
  const height = Math.max(12, process.stdout.rows || 24);
  const panelWidth = Math.min(width, Math.max(52, Math.min(78, width - 12)));
  const leftPad = Math.max(0, Math.floor((width - panelWidth) / 2));
  const panelGap = Math.max(0, width - leftPad - panelWidth);
  const panelPrefix = ' '.repeat(leftPad);
  const panelSuffix = ' '.repeat(panelGap);
  const bodyWidth = Math.max(32, panelWidth - 2);

  const status = state.busy
    ? `${c(THEME.promptBusy, SPINNER[state.frame % SPINNER.length])} ${c(THEME.muted, 'thinking')}`
    : `${c(THEME.accentSoft, '●')} ${c(THEME.muted, 'idle')}`;
  const header = centerLine(`${c(THEME.title, 'large-cli')}  ${status}`, panelWidth);
  const banner = buildBanner(bodyWidth);

  const body = [];
  for (const message of state.messages) {
    body.push(...renderMessage(message, bodyWidth));
  }

  if (state.busy) {
    body.push(`${c(THEME.promptBusy, '…')} ${c(THEME.muted, 'thinking')}`);
    body.push('');
  }

  const promptPrefix = state.busy ? c(THEME.promptBusy, '⠿') : c(THEME.prompt, '❯');
  const promptLine = `${promptPrefix} ${state.draft}`;
  const footer = [
    centerLine(c(THEME.line, '─'.repeat(Math.min(bodyWidth, 32))), panelWidth),
    centerLine(promptLine.slice(0, bodyWidth), panelWidth),
  ];

  const bodyCapacity = Math.max(0, height - 2 - banner.length - footer.length - 3);
  const visibleBody = body.slice(Math.max(0, body.length - bodyCapacity));

  const content = [header, '', ...banner, ''];
  for (const line of visibleBody) content.push(line);
  content.push('', ...footer);

  const topPad = Math.max(0, Math.floor((height - content.length) / 2));
  const blankLine = ' '.repeat(width);
  const output = [];
  for (let i = 0; i < topPad; i += 1) output.push(blankLine);
  for (const line of content) {
    output.push(`${panelPrefix}${centerLine(line, panelWidth)}${panelSuffix}`);
  }
  while (output.length < height) output.push(blankLine);

  const promptVisible = stripAnsi(promptLine);
  return {
    text: output.join('\n'),
    promptLine,
    panelWidth,
    panelSuffix,
    leftPad,
    promptRow: topPad + content.length,
    promptCol: Math.min(width, leftPad + Math.max(1, Math.floor((panelWidth - promptVisible.length) / 2)) + promptVisible.length + 1),
  };
}

function redraw() {
  const frame = buildScreen();
  moveTo(1, 1);
  process.stdout.write(frame.text);
  moveTo(frame.promptRow, frame.promptCol);
}

function updatePromptLine() {
  const frame = buildScreen();
  const line = `${' '.repeat(frame.leftPad)}${centerLine(frame.promptLine, frame.panelWidth)}${frame.panelSuffix}`;
  moveTo(frame.promptRow, 1);
  process.stdout.write(ansi('2K'));
  process.stdout.write(line);
  moveTo(frame.promptRow, frame.promptCol);
}

function addMessage(role, text) {
  state.messages.push({ role, text, time: new Date() });
  if (state.messages.length > 200) state.messages.shift();
}

function cleanupTempFile() {
  if (!state.tempFile) return;
  try {
    if (fs.existsSync(state.tempFile)) fs.unlinkSync(state.tempFile);
  } catch {
    // ignore
  }
  state.tempFile = null;
}

function stopChild() {
  if (!state.child) return;
  try {
    state.child.kill();
  } catch {
    // ignore
  }
  state.child = null;
}

async function runCodex(promptText) {
  const tempFile = isWin
    ? `${process.env.TEMP || process.env.TMP || 'C:\\Users\\aiden\\AppData\\Local\\Temp'}\\codex-tui-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
    : '/tmp/' + `codex-tui-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  state.tempFile = tempFile;

  return new Promise((resolve) => {
    const mcpOverrides = mcpOverridesFromServers(loadLocalMcpServers());
    const command = codexCommand(tempFile, mcpOverrides);
    const shell = isWin ? 'cmd.exe' : (process.env.SHELL || (isTermux ? 'sh' : 'bash'));
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-lc', command];
    const child = spawn(shell, shellArgs, {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    state.child = child;

    let stderr = '';
    let stdout = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      cleanupTempFile();
      state.child = null;
      resolve({ ok: false, error: err.message, text: '' });
    });

    child.on('close', (code) => {
      let text = '';
      try {
        text = fs.existsSync(tempFile) ? fs.readFileSync(tempFile, 'utf8').trim() : '';
      } catch {
        text = '';
      }

      cleanupTempFile();
      state.child = null;

      if (!text) {
        const fallback = stdout.trim().split(/\r?\n/).filter(Boolean);
        text = fallback.length ? fallback[fallback.length - 1] : '';
      }

      if (!text && code !== 0) {
        text = `Codex exited with code ${code}${stderr ? `:\n${stderr.trim().slice(0, 500)}` : ''}`;
      }

      resolve({ ok: code === 0, error: code === 0 ? '' : stderr.trim(), text });
    });

    child.stdin.end(promptText);
  });
}

function codexCliBinary() {
  return 'codex';
}

function quoteCliArg(value) {
  return shellQuote(value);
}

function codexCliCommand(args) {
  const binary = codexCliBinary();
  return [binary, ...args.map(quoteCliArg)].join(' ');
}

function runCodexCli(args) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];

    const finish = (code, extra = {}) => {
      resolve({
        ok: code === 0,
        code,
        stdout: stdoutChunks.join('').trim(),
        stderr: stderrChunks.join('').trim(),
        ...extra,
      });
    };

    if (isWin) {
      const command = codexCliCommand(args);
      const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
        cwd: process.cwd(),
        env: { ...process.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString('utf8')));
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));
      child.on('error', (err) => finish(-1, { stderr: err.message }));
      child.on('close', (code) => finish(code));
      child.stdin.end();
      return;
    }

    const child = spawn('codex', args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));
    child.on('error', (err) => finish(-1, { stderr: err.message }));
    child.on('close', (code) => finish(code));
  });
}

async function sendDraft() {
  const text = state.draft.trim();
  if (!text || state.busy) return;

  if (text === '/clear') {
    state.messages = [];
    state.draft = '';
    redraw();
    return;
  }

  if (text === '/mcp' || text === '/mcp list') {
    const servers = loadLocalMcpServers();
    const names = Object.keys(servers);
    if (!names.length) {
      addMessage('assistant', 'No local MCP config found. Create large-cli.mcp.json or .large-cli.mcp.json in this folder with an mcpServers object.');
    } else {
      addMessage('assistant', `Loaded MCP servers: ${names.join(', ')}. They will be passed to Codex on each run.`);
    }
    state.draft = '';
    redraw();
    return;
  }

  if (text === '/mcp market') {
    addMessage('assistant', 'MCP Market listings like https://mcpmarket.com/server/minecraft-survival can be passed to /plugin install. Use /plugin market add <source>, /plugin market upgrade [name], or /plugin market remove <name>.');
    state.draft = '';
    redraw();
    return;
  }

  if (text.startsWith('/mcp market ') || text.startsWith('/plugin ')) {
    const parts = text.split(/\s+/);
    const head = parts[0];
    const section = parts[1];
    const action = parts[2];
    const rest = parts.slice(3);

    let result = null;
    let summary = '';

    if (head === '/plugin' && section === 'install') {
      if (!rest.length) {
        addMessage('assistant', 'Usage: /plugin install <source>');
        state.draft = '';
        redraw();
        return;
      }
      const source = normalizeMcpMarketSource(rest.join(' '));
      result = await runCodexCli(['plugin', 'marketplace', 'add', source]);
      summary = isMcpMarketServerUrl(source)
        ? `MCP Market listing added: ${titleFromSlug(mcpMarketSlug(source) || source)}`
        : `Plugin marketplace added: ${source}`;
    } else if ((head === '/plugin' && section === 'market') || (head === '/mcp' && section === 'market')) {
      if (section === 'market' && !action) {
        addMessage('assistant', 'Usage: /plugin market add <source> | upgrade [name] | remove <name>');
        state.draft = '';
        redraw();
        return;
      }

      if (action === 'add') {
        if (!rest.length) {
          addMessage('assistant', 'Usage: /plugin market add <source>');
          state.draft = '';
          redraw();
          return;
        }
        const source = normalizeMcpMarketSource(rest.join(' '));
        result = await runCodexCli(['plugin', 'marketplace', 'add', source]);
        summary = isMcpMarketServerUrl(source)
          ? `MCP Market listing added: ${titleFromSlug(mcpMarketSlug(source) || source)}`
          : `Plugin marketplace added: ${source}`;
      } else if (action === 'upgrade') {
        const marketplace = rest.join(' ').trim();
        result = await runCodexCli(marketplace ? ['plugin', 'marketplace', 'upgrade', marketplace] : ['plugin', 'marketplace', 'upgrade']);
        summary = marketplace ? `Plugin marketplace upgraded: ${marketplace}` : 'Plugin marketplaces upgraded';
      } else if (action === 'remove') {
        const marketplace = rest.join(' ').trim();
        if (!marketplace) {
          addMessage('assistant', 'Usage: /plugin market remove <name>');
          state.draft = '';
          redraw();
          return;
        }
        result = await runCodexCli(['plugin', 'marketplace', 'remove', marketplace]);
        summary = `Plugin marketplace removed: ${marketplace}`;
      } else {
        addMessage('assistant', 'Usage: /plugin market add <source> | upgrade [name] | remove <name>');
        state.draft = '';
        redraw();
        return;
      }
    }

    if (result) {
      const textOut = [summary, result.stdout, result.stderr ? `stderr: ${result.stderr}` : '']
        .filter(Boolean)
        .join('\n');
      addMessage('assistant', textOut || summary || 'Done.');
    }

    state.draft = '';
    redraw();
    return;
  }

  if (text === '/help') {
    addMessage('assistant', 'Commands: /clear, /help, /exit, /mcp, /mcp market, /plugin install <mcpmarket-url>, /plugin market. This chat is powered by the Codex CLI backend.');
    state.draft = '';
    redraw();
    return;
  }

  if (text === '/exit') {
    shutdown();
    return;
  }

  addMessage('user', text);
  state.draft = '';
  state.busy = true;
  redraw();

  const prompt = buildConversationPrompt(text);
  const result = await runCodex(prompt);
  state.busy = false;

  const answer = (result.text || '').trim() || 'No response from Codex.';
  addMessage('assistant', answer);
  redraw();
}

function handleKey(str, key) {
  if (key && key.ctrl && key.name === 'c') {
    shutdown();
    return;
  }

  if (key && key.ctrl && key.name === 'j') {
    state.draft += '\n';
    updatePromptLine();
    return;
  }

  if (key && key.name === 'return') {
    void sendDraft();
    return;
  }

  if (key && key.name === 'backspace') {
    state.draft = state.draft.slice(0, -1);
    updatePromptLine();
    return;
  }

  if (key && key.ctrl && key.name === 'l') {
    redraw();
    return;
  }

  if (key && key.name === 'escape') {
    return;
  }

  if (typeof str === 'string' && str && (!key || !key.ctrl || key.name === 'space')) {
    state.draft += str;
    updatePromptLine();
  }
}

function enableWindowsAnsi() {
  if (!isWin) return;
  try {
    const { spawnSync } = require('child_process');
    spawnSync('cmd.exe', ['/c', ''], { stdio: 'ignore' });
  } catch {
    // Best effort; modern Windows terminals generally support ANSI already.
  }
}

function shutdown() {
  stopChild();
  cleanupTempFile();
  try { process.stdin.setRawMode(false); } catch {}
  try { process.stdin.pause(); } catch {}
  showCursor();
  clearScreen();
  process.stdout.write('Bye.\n');
  process.exit(0);
}

async function main() {
  enableWindowsAnsi();

  const folder = process.cwd();
  const trusted = await promptTrustWarning(folder);
  if (!trusted) {
    clearScreen();
    process.stdout.write(c(THEME.muted, 'Folder not trusted. Exiting.\n'));
    process.exit(1);
  }

  process.stdin.setEncoding('utf8');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', handleKey);
  process.stdout.on('resize', redraw);
  process.on('SIGINT', shutdown);
  process.on('exit', () => {
    try { showCursor(); } catch {}
  });

  setInterval(() => {
    if (state.busy) {
      state.frame = (state.frame + 1) % SPINNER.length;
      redraw();
    }
  }, 120).unref();

  clearScreen();
  hideCursor();
  redraw();
}

if (process.argv.includes('--check')) {
  console.log('codex-tui.js ok');
  process.exit(0);
}

if (process.argv.includes('--preview')) {
  console.log(buildScreen().text);
  process.exit(0);
}

void main().catch((err) => {
  clearScreen();
  showCursor();
  process.stdout.write(`Fatal error: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
