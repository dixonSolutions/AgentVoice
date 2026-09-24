/**
 * Terminal prompts for `agentvoice setup`.
 *
 * Every question has a default, and a non-interactive run (no TTY, or --yes)
 * takes it without asking — so the same wizard works from a shell script, a
 * package post-install hint, or CI.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { bold, dim } from './out.js';

export class Prompter {
  private rl: Interface | null = null;

  constructor(readonly interactive: boolean) {}

  private get io(): Interface {
    this.rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return this.rl;
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    if (!this.interactive) return fallback;
    const hint = fallback ? 'Y/n' : 'y/N';
    for (;;) {
      const answer = (await this.io.question(`  ${bold(question)} ${dim(`[${hint}]`)} `)).trim().toLowerCase();
      if (!answer) return fallback;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
    }
  }

  async text(question: string, fallback: string): Promise<string> {
    if (!this.interactive) return fallback;
    const answer = (await this.io.question(`  ${bold(question)} ${dim(`[${fallback}]`)} `)).trim();
    return answer || fallback;
  }

  /** Pick one of `choices` by number or id; returns the id. */
  async choose(
    question: string,
    choices: Array<{ id: string; label: string; note?: string }>,
    fallback: string,
  ): Promise<string> {
    if (!this.interactive) return fallback;
    process.stdout.write(`  ${bold(question)}\n`);
    choices.forEach((c, i) => {
      const marker = c.id === fallback ? '›' : ' ';
      process.stdout.write(`   ${marker} ${i + 1}) ${c.label}${c.note ? `  ${dim(c.note)}` : ''}\n`);
    });
    const defaultIndex = choices.findIndex((c) => c.id === fallback) + 1;
    for (;;) {
      const answer = (await this.io.question(`    ${dim(`choice [${defaultIndex}]`)} `)).trim();
      if (!answer) return fallback;
      const byNumber = choices[Number(answer) - 1];
      if (byNumber) return byNumber.id;
      const byId = choices.find((c) => c.id === answer);
      if (byId) return byId.id;
    }
  }
}
