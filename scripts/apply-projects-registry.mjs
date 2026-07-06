#!/usr/bin/env node
/**
 * Merge config/projects.registry.json into config.json with machine-local absolute paths.
 *
 * Usage: node scripts/apply-projects-registry.mjs [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const registryPath = join(root, 'config', 'projects.registry.json');
const configPath = join(root, 'config.json');
const dryRun = process.argv.includes('--dry-run');

function resolveProjectPath(entry, projectsRoot) {
  const candidates = [entry.relativePath, ...(entry.pathCandidates ?? [])];
  for (const rel of candidates) {
    const abs = join(projectsRoot, rel);
    if (existsSync(abs)) return abs;
  }
  return join(projectsRoot, entry.relativePath);
}

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const projectsRoot = join(homedir(), registry.projectsRoot);

const projects = registry.projects.map((entry) => ({
  name: entry.name,
  path: resolveProjectPath(entry, projectsRoot),
  aliases: entry.aliases ?? [],
  description: entry.description,
  enabled: true,
}));

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  console.error(`Could not read ${configPath} — copy from config.example.json first.`);
  process.exit(1);
}

config.projects = projects;

if (dryRun) {
  console.log(JSON.stringify({ projectsRoot, projects }, null, 2));
  process.exit(0);
}

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`Updated ${configPath} with ${projects.length} projects (root: ${projectsRoot})`);
