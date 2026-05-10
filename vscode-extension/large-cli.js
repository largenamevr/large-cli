#!/usr/bin/env node
'use strict';

const fs = require('fs');
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
  process.stdout.write(ansi('2J') + ansi('H'));
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

function codexCommand(tempFile) {
  const binary = isWin ? 'codex.cmd' : 'codex';
  const quote = isWin ? cmdQuote : shellQuote;
  return [
    `${binary} exec`,
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox read-only',
    '--color never',
    '--output-last-message',
    quote(tempFile),
  ].join(' ');
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
    promptRow: topPad + content.length,
    promptCol: Math.min(width, leftPad + Math.max(1, Math.floor((panelWidth - promptVisible.length) / 2)) + promptVisible.length + 1),
  };
}

function redraw() {
  clearScreen();
  const frame = buildScreen();
  process.stdout.write(frame.text);
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

function runCodex(promptText) {
  const tempFile = isWin
    ? `${process.env.TEMP || process.env.TMP || 'C:\\Users\\aiden\\AppData\\Local\\Temp'}\\codex-tui-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
    : '/tmp/' + `codex-tui-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  state.tempFile = tempFile;

  return new Promise((resolve) => {
    const command = codexCommand(tempFile);
    const child = spawn(isWin ? 'cmd.exe' : 'bash', isWin ? ['/d', '/s', '/c', command] : ['-lc', command], {
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

async function sendDraft() {
  const text = state.draft.trim();
  if (!text || state.busy) return;

  if (text === '/clear') {
    state.messages = [];
    state.draft = '';
    redraw();
    return;
  }

  if (text === '/help') {
    addMessage('assistant', 'Commands: /clear, /help, /exit. This chat is powered by the Codex CLI backend.');
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
    redraw();
    return;
  }

  if (key && key.name === 'return') {
    void sendDraft();
    return;
  }

  if (key && key.name === 'backspace') {
    state.draft = state.draft.slice(0, -1);
    redraw();
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
    redraw();
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

function main() {
  enableWindowsAnsi();
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

main();
