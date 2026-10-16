/**
 * What is left of a chat message once the bot's tag is taken out.
 *
 * People write `@Squeakr sessions`, `@Squeakr\nsessions`,
 * `@Squeakr: default 2`, `hey @Squeakr, status` — and Discord inserts
 * the bot's *role* mention (`<@&id>`) as often as its user mention. Every
 * form of the tag goes, wherever it sits, along with the spaces, line breaks
 * and punctuation that separated it from the command, and invisible
 * zero-width characters that chat clients paste in.
 */

const ZERO_WIDTH = /[​-‍⁠﻿]/g;

export function cleanCommandText(raw: string, tags: Array<string | RegExp> = []): string {
  let text = raw.replace(ZERO_WIDTH, '');
  for (const tag of tags) {
    text = typeof tag === 'string' ? text.split(tag).join(' ') : text.replace(tag, ' ');
  }
  return text
    .replace(/^[\s:,;\-–—]+/, '') // separators between the tag and the command
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Command head and argument words: any whitespace, line breaks included, separates them. */
export function splitCommand(text: string): { cmd: string; args: string[]; rest: string } {
  const trimmed = text.trim();
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  const cmd = (match?.[1] ?? '').toLowerCase().replace(/^\//, '');
  const rest = (match?.[2] ?? '').trim();
  return { cmd, args: rest ? rest.split(/\s+/) : [], rest };
}
