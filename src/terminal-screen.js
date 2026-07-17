const sessions = new WeakMap();

export function acquireTerminalScreen(output = process.stdout) {
  if (!output?.isTTY) return () => {};
  const state = sessions.get(output) || { depth: 0 };
  if (state.depth === 0) output.write('\x1b[?1049h');
  state.depth += 1;
  sessions.set(output, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.depth = Math.max(0, state.depth - 1);
    if (state.depth === 0) {
      sessions.delete(output);
      output.write('\x1b[?1049l');
    }
  };
}

export function terminalScreenDepth(output = process.stdout) {
  return sessions.get(output)?.depth || 0;
}
