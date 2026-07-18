import chalk from 'chalk';
import stringWidth from 'string-width';
import { acquireTerminalScreen } from './terminal-screen.js';

const ENTER_MODES = '\x1b[?1007l\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[2J\x1b[H';
const EXIT_MODES = '\x1b[?1000l\x1b[?1006l\x1b[?1007h\x1b[?25h';

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function terminalListViewport(itemCount, selectedIndex, capacity, previousStart = 0) {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  const rows = Math.max(0, Math.floor(Number(capacity) || 0));
  if (!count || !rows) return { start: 0, end: 0, selectedIndex: count ? 0 : -1 };
  const selected = clamp(Math.floor(Number(selectedIndex) || 0), 0, count - 1);
  const maximumStart = Math.max(0, count - rows);
  let start = clamp(Math.floor(Number(previousStart) || 0), 0, maximumStart);
  if (selected < start) start = selected;
  else if (selected >= start + rows) start = selected - rows + 1;
  start = clamp(start, 0, maximumStart);
  return { start, end: Math.min(count, start + rows), selectedIndex: selected };
}

export function terminalListAction(buffer) {
  const key = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (key === '\x03') return { type: 'interrupt' };
  if (key === 'q' || key === 'Q' || key === '\x1b') return { type: 'cancel' };
  if (key.includes('\r') || key.includes('\n')) return { type: 'select' };
  if (key === ' ') return { type: 'alternate' };
  if (key === 'd' || key === 'D') return { type: 'detail' };
  const wheel = /\x1b\[<(\d+);\d+;\d+([Mm])/.exec(key);
  if (wheel) {
    const button = Number(wheel[1]);
    if (wheel[2] === 'M' && (button & 64) === 64) {
      return { type: 'move', delta: (button & 1) === 0 ? -1 : 1 };
    }
  }
  if (key.includes('\x1b[A')) return { type: 'move', delta: -1 };
  if (key.includes('\x1b[B')) return { type: 'move', delta: 1 };
  return { type: 'ignore' };
}

function truncatePlain(text, maximumWidth) {
  const value = String(text ?? '').replace(/[\r\n]+/g, ' ');
  if (stringWidth(value) <= maximumWidth) return value;
  if (maximumWidth <= 1) return '…'.slice(0, maximumWidth);
  let result = '';
  for (const character of value) {
    if (stringWidth(result + character) > maximumWidth - 1) break;
    result += character;
  }
  return `${result}…`;
}

function restoreRawInput(stream, rl, state, onData) {
  try { stream.pause(); } catch {}
  stream.removeListener('data', onData);
  for (const listener of state.listeners) stream.on('data', listener);
  try { stream.setRawMode(state.wasRaw); } catch {}
  try { rl?.write(null, { ctrl: true, name: 'u' }); } catch {}
  if (!state.wasPaused) {
    try { stream.resume(); } catch {}
    try { rl?.resume(); } catch {}
  }
}

export async function readTerminalKey({
  rl,
  prompt,
  keys,
  signal,
  onInterrupt,
  onResize,
  input = process.stdin,
  output = process.stdout
}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return null;
  const allowed = new Set(keys.map((key) => key.toLowerCase()));
  const promptText = () => typeof prompt === 'function' ? String(prompt()) : String(prompt);
  let settle;
  const completion = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let finished = false;
  const finish = (value) => {
    if (finished) return;
    finished = true;
    settle.resolve(value);
  };
  const onData = (buffer) => {
    const value = buffer.toString('utf8');
    if (value === '\x03') {
      onInterrupt?.();
      return;
    }
    if (value === '\x1b' && allowed.has('q')) return finish('q');
    const key = value.toLowerCase();
    if (allowed.has(key)) finish(key);
  };
  const abort = () => {
    if (finished) return;
    finished = true;
    settle.reject(signal.reason || new DOMException('操作已取消', 'AbortError'));
  };
  const inputState = {
    wasRaw: Boolean(input.isRaw),
    wasPaused: input.isPaused(),
    listeners: input.listeners('data')
  };
  let inputAttached = false;
  let resizeGeneration = 0;
  const resize = () => {
    const generation = ++resizeGeneration;
    Promise.resolve(onResize?.()).then(() => {
      if (!finished && generation === resizeGeneration) output.write(promptText());
    }).catch(() => {});
  };
  try {
    rl?.pause();
    for (const listener of inputState.listeners) input.removeListener('data', listener);
    input.on('data', onData);
    inputAttached = true;
    input.setRawMode(true);
    input.resume();
    output.write(promptText());
    if (onResize) output.on('resize', resize);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const result = await completion;
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (onResize) output.removeListener('resize', resize);
    if (inputAttached) restoreRawInput(input, rl, inputState, onData);
    output.write('\x1b[?25h');
  }
}

export async function selectTerminalList({
  rl,
  items,
  initialIndex = 0,
  title = '请选择',
  hint = '↑/↓ 或滚轮选择  Enter 查看  q/Esc 返回',
  alternateAction = null,
  detailAction = null,
  itemText = (item) => String(item),
  signal,
  onInterrupt,
  onFrame,
  input = process.stdin,
  output = process.stdout
}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return null;
  if (!Array.isArray(items) || !items.length) return null;

  let selectedIndex = clamp(Math.floor(Number(initialIndex) || 0), 0, items.length - 1);
  let viewportStart = 0;
  let settle;
  const completion = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let finished = false;

  const render = () => {
    const rows = Math.max(4, output.rows || 24);
    const columns = Math.max(8, output.columns || 80);
    const viewport = terminalListViewport(items.length, selectedIndex, Math.max(1, rows - 3), viewportStart);
    viewportStart = viewport.start;
    selectedIndex = viewport.selectedIndex;
    const lines = [chalk.cyanBright.bold(truncatePlain(title, columns)), chalk.whiteBright(truncatePlain(hint, columns))];
    for (let index = viewport.start; index < viewport.end; index += 1) {
      const prefix = index === selectedIndex ? '› ' : '  ';
      const line = truncatePlain(`${prefix}${itemText(items[index], index)}`, columns);
      lines.push(index === selectedIndex ? chalk.inverse(line) : line);
    }
    onFrame?.([...lines, ...Array.from({ length: Math.max(0, rows - lines.length) }, () => '')]);
    output.write(`\x1b[2J\x1b[H${lines.join('\n')}`);
  };

  const finish = (value) => {
    if (finished) return;
    finished = true;
    settle.resolve(value);
  };
  const onData = (buffer) => {
    const action = terminalListAction(buffer);
    if (action.type === 'interrupt') onInterrupt?.();
    else if (action.type === 'cancel') finish(null);
    else if (action.type === 'select') finish(selectedIndex);
    else if (action.type === 'alternate' && alternateAction) finish({ index: selectedIndex, action: alternateAction });
    else if (action.type === 'detail' && detailAction) finish({ index: selectedIndex, action: detailAction });
    else if (action.type === 'move') {
      selectedIndex = clamp(selectedIndex + action.delta, 0, items.length - 1);
      render();
    }
  };
  const abort = () => {
    if (finished) return;
    finished = true;
    settle.reject(signal.reason || new DOMException('操作已取消', 'AbortError'));
  };
  const inputState = {
    wasRaw: Boolean(input.isRaw),
    wasPaused: input.isPaused(),
    listeners: input.listeners('data')
  };
  let inputAttached = false;
  const releaseScreen = acquireTerminalScreen(output);
  const resize = () => render();
  try {
    rl?.pause();
    for (const listener of inputState.listeners) input.removeListener('data', listener);
    input.on('data', onData);
    inputAttached = true;
    input.setRawMode(true);
    input.resume();
    output.write(ENTER_MODES);
    output.on('resize', resize);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else render();
    return await completion;
  } finally {
    signal?.removeEventListener('abort', abort);
    output.removeListener('resize', resize);
    if (inputAttached) restoreRawInput(input, rl, inputState, onData);
    try { output.write(EXIT_MODES); } catch {}
    releaseScreen();
  }
}
