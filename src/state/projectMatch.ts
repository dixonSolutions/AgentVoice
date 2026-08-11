/**
 * Voice/STT-tolerant project name matching.
 *
 * Speech recognition often mishears "cursor" as "casa" / "kasa". Normalization
 * runs before exact and fuzzy registry lookup.
 */

/** Common mis-hearings → canonical token (applied before alphanumeric fold). */
const STT_WORD_FIXES: Array<[RegExp, string]> = [
  [/\bcasa\b/gi, 'cursor'],
  [/\bkasa\b/gi, 'cursor'],
  [/\bcars\s+of\s+voice\b/gi, 'cursorvoice'],
  [/\bcursor\s+of\s+voice\b/gi, 'cursorvoice'],
  [/\bcurse\s*or\b/gi, 'cursor'],
  [/\bcursor\s+voice\b/gi, 'cursorvoice'],
  [/\bagent\s+voice\b/gi, 'agentvoice'],
  [/\bagentvoice\b/gi, 'agentvoice'],
];

/** Collapse to lowercase alphanumeric for comparison. */
export function foldProjectQuery(input: string): string {
  let s = input.trim().toLowerCase();
  for (const [pattern, replacement] of STT_WORD_FIXES) {
    s = s.replace(pattern, replacement);
  }
  return s.replace(/[^a-z0-9]/g, '');
}

/** True when folded query matches project name or any alias. */
export function foldedProjectMatch(
  query: string,
  name: string,
  aliases: string[],
): boolean {
  const q = foldProjectQuery(query);
  if (!q) return false;
  if (foldProjectQuery(name) === q) return true;
  return aliases.some((a) => foldProjectQuery(a) === q);
}

/** Score 0–1 similarity for disambiguation hints. */
export function projectMatchScore(query: string, name: string, aliases: string[]): number {
  const q = foldProjectQuery(query);
  if (!q) return 0;
  const candidates = [name, ...aliases].map(foldProjectQuery);
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    if (c === q) return 1;
    if (c.includes(q) || q.includes(c)) best = Math.max(best, 0.85);
    best = Math.max(best, 1 - levenshtein(q, c) / Math.max(q.length, c.length));
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}
