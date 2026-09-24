/**
 * Work out a project entry — name, description, spoken aliases — from the
 * directory itself, so `agentvoice add` and `agentvoice local` register a
 * project with more than a folder name.
 *
 * Read, never run: manifests are parsed as text (package.json, Cargo.toml,
 * pyproject.toml, go.mod), the README's first paragraph is taken as prose, and
 * git is asked only for the origin URL. First source to answer wins; each
 * answer records where it came from so the CLI can say.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { capture } from './exec.js';

export interface ProjectDetails {
  /** Absolute, symlinks resolved. */
  path: string;
  /** Slug-safe (a–z, 0–9, -, _), as config.json requires. */
  name: string;
  description: string | null;
  /** Spoken forms for speech-to-text, lower case, deduplicated. */
  aliases: string[];
  /** Is this directory a git work tree? (Discovery only picks those up.) */
  git: boolean;
  /** Where each field came from, e.g. { name: 'package.json' }. */
  sources: { name: string; description: string | null };
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return slug || 'project';
}

/** "agent-voice_web" → "agent voice web"; null when it would say nothing new. */
function spoken(value: string): string | null {
  const words = value
    .replace(/^@[^/]+\//, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_./]+/g, ' ')
    .trim()
    .toLowerCase();
  return words || null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** `key = "value"` inside a TOML `[section]` — enough for name/description. */
function tomlField(text: string, section: string, key: string): string | null {
  const start = text.indexOf(`[${section}]`);
  if (start < 0) return null;
  const rest = text.slice(start + section.length + 2);
  const body = rest.split(/^\s*\[/m)[0] ?? '';
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(body);
  return match?.[1]?.trim() || null;
}

interface Manifest {
  source: string;
  name: string | null;
  description: string | null;
}

function manifests(dir: string): Manifest[] {
  const found: Manifest[] = [];

  const pkg = readText(join(dir, 'package.json'));
  if (pkg) {
    try {
      const json = JSON.parse(pkg) as { name?: unknown; description?: unknown };
      found.push({
        source: 'package.json',
        name: typeof json.name === 'string' ? json.name.replace(/^@[^/]+\//, '') : null,
        description: typeof json.description === 'string' ? json.description.trim() || null : null,
      });
    } catch {
      /* unparseable package.json says nothing */
    }
  }

  const cargo = readText(join(dir, 'Cargo.toml'));
  if (cargo) {
    found.push({
      source: 'Cargo.toml',
      name: tomlField(cargo, 'package', 'name'),
      description: tomlField(cargo, 'package', 'description'),
    });
  }

  const pyproject = readText(join(dir, 'pyproject.toml'));
  if (pyproject) {
    found.push({
      source: 'pyproject.toml',
      name: tomlField(pyproject, 'project', 'name') ?? tomlField(pyproject, 'tool.poetry', 'name'),
      description: tomlField(pyproject, 'project', 'description') ?? tomlField(pyproject, 'tool.poetry', 'description'),
    });
  }

  const gomod = readText(join(dir, 'go.mod'));
  const module = gomod ? /^module\s+(\S+)/m.exec(gomod)?.[1] : undefined;
  if (module) found.push({ source: 'go.mod', name: module.split('/').pop() ?? null, description: null });

  return found;
}

/**
 * First real paragraph of the README: skips headings, badges, HTML, code
 * fences and blockquotes, strips inline markdown, and caps it at a sentence or
 * two — this is read aloud and shown in a dropdown, not rendered.
 */
export function readmeSummary(text: string): string | null {
  let inFence = false;
  const paragraph: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (/^(#|<|!\[|\[!\[|>|\||---|===|\* \* \*)/.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }
  if (!paragraph.length) return null;

  const plain = paragraph
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  return clampDescription(plain);
}

/** config.json and the admin API cap descriptions at 200 characters. */
export function clampDescription(text: string): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (plain.length <= 200) return plain;
  const cut = plain.slice(0, 199);
  const sentence = cut.lastIndexOf('. ');
  return sentence > 60 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

function readme(dir: string): string | null {
  for (const name of ['README.md', 'README.markdown', 'README.rst', 'README.txt', 'README', 'readme.md']) {
    const text = readText(join(dir, name));
    if (text) return readmeSummary(text);
  }
  return null;
}

/** Is `dir` a repo root, and its name from `git remote get-url origin` ("AgentVoice"). */
async function gitInfo(dir: string): Promise<{ git: boolean; repo: string | null }> {
  const top = await capture('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 3000 });
  if (top.code !== 0) return { git: false, repo: null };
  // A subfolder of someone else's repo is not "a git project" — and its
  // origin names the parent, not this directory.
  let root = top.stdout.trim();
  try {
    root = realpathSync(root);
  } catch {
    /* compare as given */
  }
  if (root !== dir) return { git: false, repo: null };
  const origin = await capture('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 3000 });
  const url = origin.code === 0 ? origin.stdout.trim() : '';
  const repo = url ? (url.replace(/\.git$/, '').split(/[/:]/).pop() ?? null) : null;
  return { git: true, repo: repo || null };
}

export async function detectProjectDetails(dir: string): Promise<ProjectDetails> {
  let path = dir;
  try {
    path = realpathSync(dir);
  } catch {
    /* keep as given */
  }
  const folder = basename(path);
  const found = manifests(path);
  const git = existsSync(path) ? await gitInfo(path) : { git: false, repo: null };

  const named = found.find((m) => m.name);
  const nameSource = named?.name ?? git.repo ?? folder;
  const described = found.find((m) => m.description);
  const readmeText = described ? null : readme(path);

  const name = slugify(nameSource);
  const aliasCandidates = [spoken(folder), spoken(nameSource), git.repo ? spoken(git.repo) : null];
  const aliases = [...new Set(aliasCandidates.filter((a): a is string => Boolean(a)))].filter(
    (alias) => alias !== name,
  );

  return {
    path,
    name,
    description: described?.description ? clampDescription(described.description) : readmeText,
    aliases,
    git: git.git,
    sources: {
      name: named ? named.source : git.repo ? 'git remote' : 'folder name',
      description: described ? described.source : readmeText ? 'README' : null,
    },
  };
}
