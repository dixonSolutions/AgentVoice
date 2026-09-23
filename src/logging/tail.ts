/**
 * Read the end of a log file, and follow it as it grows — for the in-app log
 * viewer when journald has nothing (npm installs, manual runs) and for
 * `agentvoice logs --follow`.
 */

import { closeSync, existsSync, openSync, readSync, statSync, unwatchFile, watchFile } from 'node:fs';

/** Last `n` lines of a plain-text file. Reads only the tail, so large files are cheap. */
export function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const want = Math.min(size, Math.max(8192, n * 512));
  if (want === 0) return [];
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf-8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    // The first line is probably cut mid-way unless we read from the start.
    if (want < size) lines.shift();
    return lines.slice(-n);
  } finally {
    closeSync(fd);
  }
}

export interface FileFollow {
  stop: () => void;
}

/**
 * Emit complete lines appended to a file from now on. `resolvePath` is asked
 * again on every poll, so a writer that rolls to a new file (midnight, size
 * cap) is followed onto it.
 */
export function followFile(
  resolvePath: () => string | null,
  onLine: (line: string) => void,
  intervalMs = 500,
): FileFollow {
  let path = resolvePath();
  let offset = path && existsSync(path) ? statSync(path).size : 0;
  let partial = '';
  let stopped = false;

  const poll = (): void => {
    if (stopped) return;
    const next = resolvePath();
    if (next && next !== path) {
      if (path) unwatchFile(path, poll);
      path = next;
      offset = 0;
      partial = '';
      watchFile(path, { interval: intervalMs }, poll);
    }
    if (!path || !existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = partial + buf.toString('utf-8');
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    } finally {
      closeSync(fd);
    }
  };

  if (path) watchFile(path, { interval: intervalMs }, poll);
  // Also poll on a timer: watchFile only fires for the file it watches, and a
  // rollover creates a different one.
  const timer = setInterval(poll, Math.max(intervalMs * 4, 1000));
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (path) unwatchFile(path, poll);
    },
  };
}
