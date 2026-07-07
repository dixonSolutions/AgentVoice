/**
 * System prompt admin routes — list prompt files and configure the active one.
 *
 * Routes:
 *   GET  /api/admin/system-prompts        — list available prompt files + active selection
 *   PATCH /api/admin/system-prompts       — set active system prompt file path
 *   GET  /api/admin/system-prompts/read   — read contents of a prompt file
 */

import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { z } from 'zod';
import { getConfig, getConfigPath } from '../config.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { childLogger } from '../log.js';

const log = childLogger('systemPrompts');

function getRepoRoot(): string {
  return dirname(resolve(getConfigPath()));
}

/** Recursively list .md files under a directory, returning relative paths. */
function listMarkdownFiles(dir: string, repoRoot: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listMarkdownFiles(fullPath, repoRoot));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(relative(repoRoot, fullPath));
      }
    }
  } catch {
    // skip unreadable directories
  }
  return results;
}

const SystemPromptPatchSchema = z
  .object({
    /** Relative or absolute path to the system prompt file. Null to reset to built-in default. */
    systemPromptFile: z.string().min(1).nullable(),
  })
  .strict();

const ReadQuerySchema = z.object({
  path: z.string().min(1),
});

export async function registerSystemPromptsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/admin/system-prompts — list discoverable prompt files and active selection. */
  app.get('/api/admin/system-prompts', async () => {
    const repoRoot = getRepoRoot();
    const promptsDir = join(repoRoot, 'prompts');
    const files = listMarkdownFiles(promptsDir, repoRoot);
    const active = getConfig().settings.systemPromptFile ?? null;
    return { files, active, defaultFile: 'prompts/cursor-voice/system.md' };
  });

  /** PATCH /api/admin/system-prompts — set or clear the active system prompt file. */
  app.patch<{ Body: unknown }>('/api/admin/system-prompts', async (req, reply) => {
    const parsed = SystemPromptPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    const { systemPromptFile } = parsed.data;

    if (systemPromptFile !== null) {
      const repoRoot = getRepoRoot();
      const absolutePath = resolve(repoRoot, systemPromptFile);
      if (!existsSync(absolutePath)) {
        return reply.code(400).send({ error: `Prompt file not found: ${systemPromptFile}` });
      }
      const stat = statSync(absolutePath);
      if (!stat.isFile()) {
        return reply.code(400).send({ error: `Path is not a file: ${systemPromptFile}` });
      }
    }

    const cfg = readConfigFile();
    if (systemPromptFile === null) {
      delete (cfg.settings as Record<string, unknown>)['systemPromptFile'];
    } else {
      (cfg.settings as Record<string, unknown>)['systemPromptFile'] = systemPromptFile;
    }
    writeConfigFile(cfg);
    log.info({ systemPromptFile }, 'system prompt updated');

    const active = getConfig().settings.systemPromptFile ?? null;
    return { ok: true, active };
  });

  /** GET /api/admin/system-prompts/read?path=<relative-path> — read file contents. */
  app.get<{ Querystring: unknown }>('/api/admin/system-prompts/read', async (req, reply) => {
    const parsed = ReadQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'path query parameter is required' });
    }

    const repoRoot = getRepoRoot();
    const absolutePath = resolve(repoRoot, parsed.data.path);

    if (!existsSync(absolutePath)) {
      return reply.code(404).send({ error: `File not found: ${parsed.data.path}` });
    }

    try {
      const content = readFileSync(absolutePath, 'utf-8');
      return { path: parsed.data.path, content };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
