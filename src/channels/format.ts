/**
 * The command line writes one small markup — `**bold**`, `_italic_`,
 * `` `code` `` — and each platform gets its own dialect of it.
 */

const TOKENS = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w])_[^_\n]+_(?![\w]))/g;

function convert(text: string, wrap: { bold: (s: string) => string; italic: (s: string) => string; code: (s: string) => string; plain: (s: string) => string }): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKENS)) {
    out += wrap.plain(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out += wrap.code(t.slice(1, -1));
    else if (t.startsWith('**')) out += wrap.bold(t.slice(2, -2));
    else out += wrap.italic(t.slice(1, -1));
    last = m.index! + t.length;
  }
  return out + wrap.plain(text.slice(last));
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Telegram `parse_mode: HTML`. */
export function toTelegramHtml(text: string): string {
  return convert(text, {
    bold: (s) => `<b>${escapeHtml(s)}</b>`,
    italic: (s) => `<i>${escapeHtml(s)}</i>`,
    code: (s) => `<code>${escapeHtml(s)}</code>`,
    plain: escapeHtml,
  });
}

/** Slack mrkdwn. */
export function toSlackMrkdwn(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return convert(text, { bold: (s) => `*${esc(s)}*`, italic: (s) => `_${esc(s)}_`, code: (s) => `\`${esc(s)}\``, plain: esc });
}

/** WhatsApp formatting. */
export function toWhatsApp(text: string): string {
  return convert(text, { bold: (s) => `*${s}*`, italic: (s) => `_${s}_`, code: (s) => `\`\`\`${s}\`\`\``, plain: (s) => s });
}

/** Split a long reply at line breaks to fit a platform's message limit. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const piece = line.length > limit ? line.match(new RegExp(`.{1,${limit}}`, 'g'))! : [line];
    for (const p of piece) {
      if (current && current.length + 1 + p.length > limit) {
        chunks.push(current);
        current = p;
      } else {
        current = current ? `${current}\n${p}` : p;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
