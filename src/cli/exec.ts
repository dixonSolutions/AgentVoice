/**
 * Two ways to run a child process, and the difference matters.
 *
 * `capture` is for probes — systemctl, git, journalctl — where we want the text
 * and an exit code and never want the child scribbling on the user's terminal.
 * `passthrough` is for the long jobs the user is watching (`update`, `logs -f`),
 * where the child owns the terminal and its exit code becomes ours.
 */

import { spawn } from 'node:child_process';

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

export function capture(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<Captured> {
  return new Promise((settle) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 10_000);
    timer.unref();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    // A missing binary is an answer, not a crash: "systemctl is not installed"
    // is exactly what the caller wants to hear.
    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ code: 127, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Did the command run at all? 127 is our "could not spawn" marker. */
export function ran(result: Captured): boolean {
  return result.code !== 127;
}

export function passthrough(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<number> {
  return new Promise((settle) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: 'inherit' });
    child.on('error', (err) => {
      process.stderr.write(`agentvoice: cannot run ${command} — ${err.message}\n`);
      settle(127);
    });
    // Ctrl-C reaches the child through the shared terminal; wait for it to go
    // rather than exiting out from under it and orphaning a build.
    child.on('close', (code, signal) => settle(signal ? 130 : (code ?? 1)));
  });
}
