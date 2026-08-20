/**
 * Safe read/write helpers for `.env` AWS IAM keys.
 *
 * Keys are never returned to the web app — only configured/complete status.
 * Updates are audited (without logging secret values).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { reloadConfig } from '../config.js';
import { isAwsEnvViable } from '../intelligence/aws/credentials.js';
import { childLogger } from '../log.js';
import { writeAudit } from './db.js';

const log = childLogger('envFile');

export interface EnvKeyField {
  envVar: string;
  label: string;
  minLength: number;
  secret: boolean;
  optional?: boolean;
}

export interface EnvKeyStatus {
  envVar: string;
  label: string;
  secret: boolean;
  optional: boolean;
  configured: boolean;
  complete: boolean;
}

export const AWS_ENV_KEYS: EnvKeyField[] = [
  { envVar: 'AWS_ACCESS_KEY_ID', label: 'IAM Access Key ID', minLength: 16, secret: false },
  { envVar: 'AWS_SECRET_ACCESS_KEY', label: 'IAM Secret Access Key', minLength: 20, secret: true },
  {
    envVar: 'AWS_BEARER_TOKEN_BEDROCK',
    label: 'Bedrock API Key (text only — not for Polly/Transcribe)',
    minLength: 40,
    secret: true,
    optional: true,
  },
  { envVar: 'AWS_REGION', label: 'Region', minLength: 5, secret: false, optional: true },
];

/**
 * Auth credentials the agent providers can persist without a browser round-trip
 * (API keys, long-lived tokens). Keys are never returned to the web app.
 */
export const AGENT_AUTH_ENV_KEYS: EnvKeyField[] = [
  { envVar: 'CURSOR_API_KEY', label: 'Cursor API key', minLength: 8, secret: true, optional: true },
  { envVar: 'OPENAI_API_KEY', label: 'Codex (OpenAI) API key', minLength: 8, secret: true, optional: true },
  {
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    label: 'Claude Code setup-token',
    minLength: 8,
    secret: true,
    optional: true,
  },
  { envVar: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', minLength: 8, secret: true, optional: true },
];

/**
 * Speech-to-text provider credentials. OPENAI_API_KEY is shared with the Codex
 * agent client (AGENT_AUTH_ENV_KEYS above) — same variable, listed twice so it
 * can be set from either screen.
 */
export const SPEECH_ENV_KEYS: EnvKeyField[] = [
  { envVar: 'OPENAI_API_KEY', label: 'OpenAI API key', minLength: 8, secret: true, optional: true },
  { envVar: 'GROQ_API_KEY', label: 'Groq API key', minLength: 8, secret: true, optional: true },
  { envVar: 'DEEPGRAM_API_KEY', label: 'Deepgram API key', minLength: 8, secret: true, optional: true },
  {
    envVar: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs API key',
    minLength: 8,
    secret: true,
    optional: true,
  },
  { envVar: 'GEMINI_API_KEY', label: 'Google Gemini API key', minLength: 8, secret: true, optional: true },
  {
    envVar: 'OPENROUTER_API_KEY',
    label: 'OpenRouter API key',
    minLength: 8,
    secret: true,
    optional: true,
  },
];

/**
 * HostingProvider secrets/paths persisted by the Serve/Network setup wizard —
 * never in config.json since some of these grant tunnel access.
 */
export const HOSTING_ENV_KEYS: EnvKeyField[] = [
  { envVar: 'NGROK_AUTHTOKEN', label: 'ngrok authtoken', minLength: 8, secret: true, optional: true },
  {
    envVar: 'CLOUDFLARE_TUNNEL_TOKEN',
    label: 'Cloudflare tunnel token',
    minLength: 8,
    secret: true,
    optional: true,
  },
  { envVar: 'HTTPS_CERT_PATH', label: 'TLS certificate path (lan provider)', minLength: 1, secret: false, optional: true },
  { envVar: 'HTTPS_KEY_PATH', label: 'TLS private key path (lan provider)', minLength: 1, secret: false, optional: true },
];

/** Read raw .env file into a key→value map (does not merge process.env). */
function parseEnvFile(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(filePath)) return map;

  const lines = readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function validateKeyField(field: EnvKeyField, value: string | undefined): EnvKeyStatus {
  const configured = Boolean(value && value.length > 0);
  const complete =
    field.optional && !configured
      ? true
      : configured && (value?.length ?? 0) >= field.minLength;

  return {
    envVar: field.envVar,
    label: field.label,
    secret: field.secret,
    optional: Boolean(field.optional),
    configured,
    complete,
  };
}

export function getAwsKeyStatus(env: Record<string, string | undefined>): EnvKeyStatus[] {
  return AWS_ENV_KEYS.map((field) => validateKeyField(field, env[field.envVar]));
}

export function isAwsConfigured(env: Record<string, string | undefined>): boolean {
  return isAwsEnvViable(env);
}

/**
 * Merge `updates` into `.env` for the given allowed key set.
 * Preserves unrelated lines and comments; empty values delete the key.
 * Shared by updateAwsEnvKeys and updateAgentEnvKeys — one file-writing path.
 */
function writeEnvKeys(fields: EnvKeyField[], updates: Record<string, string>, auditTool: string): void {
  const allowed = new Set(fields.map((k) => k.envVar));

  for (const key of Object.keys(updates)) {
    if (!allowed.has(key)) {
      throw new Error(`Env var "${key}" is not recognized here`);
    }
    const field = fields.find((f) => f.envVar === key)!;
    const value = updates[key]?.trim() ?? '';
    if (value.length > 0 && value.length < field.minLength) {
      throw new Error(`${key} is too short (min ${field.minLength} characters)`);
    }
  }

  const envPath = resolve(process.cwd(), '.env');
  const map = parseEnvFile(envPath);

  for (const [key, value] of Object.entries(updates)) {
    if (value.trim().length === 0) {
      map.delete(key);
      delete process.env[key];
    } else {
      map.set(key, value.trim());
      process.env[key] = value.trim();
    }
  }

  const lines: string[] = [];
  const written = new Set<string>();

  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of existing) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        lines.push(line);
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        lines.push(line);
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      if (map.has(key)) {
        lines.push(`${key}=${map.get(key)}`);
        written.add(key);
      } else if (allowed.has(key) && updates[key] !== undefined) {
        written.add(key);
      } else {
        lines.push(line);
      }
    }
  }

  for (const [key, value] of map.entries()) {
    if (!written.has(key) && allowed.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  log.info({ keys: Object.keys(updates) }, `${auditTool} updated`);
  writeAudit({
    tool: auditTool,
    result: 'ok',
    reason: `updated: ${Object.keys(updates).join(', ')}`,
  });

  reloadConfig();
}

/**
 * Update AWS env vars in `.env`.
 * Merges with existing file; preserves unrelated lines and comments.
 */
export function updateAwsEnvKeys(updates: Record<string, string>): void {
  writeEnvKeys(AWS_ENV_KEYS, updates, 'aws_env_keys');
}

/**
 * Update agent-provider auth credentials (API keys / long-lived tokens) in `.env`.
 * Used by the AgentProvider api-key / token-paste login flows.
 */
export function updateAgentEnvKeys(updates: Record<string, string>): void {
  writeEnvKeys(AGENT_AUTH_ENV_KEYS, updates, 'agent_env_keys');
}

export function getAgentAuthKeyStatus(env: Record<string, string | undefined>): EnvKeyStatus[] {
  return AGENT_AUTH_ENV_KEYS.map((field) => validateKeyField(field, env[field.envVar]));
}

/**
 * Update hosting-provider secrets/paths (ngrok authtoken, Cloudflare tunnel
 * token, lan TLS cert/key paths) in `.env`.
 */
export function updateHostingEnvKeys(updates: Record<string, string>): void {
  writeEnvKeys(HOSTING_ENV_KEYS, updates, 'hosting_env_keys');
}

export function getHostingKeyStatus(env: Record<string, string | undefined>): EnvKeyStatus[] {
  return HOSTING_ENV_KEYS.map((field) => validateKeyField(field, env[field.envVar]));
}

/**
 * Update speech-to-text provider keys in `.env`. AWS keys are deliberately not
 * in this set — they stay under the Bedrock/IAM screen since they also grant
 * Polly and Bedrock access.
 */
export function updateSpeechEnvKeys(updates: Record<string, string>): void {
  writeEnvKeys(SPEECH_ENV_KEYS, updates, 'speech_env_keys');
}

export function getSpeechKeyStatus(env: Record<string, string | undefined>): EnvKeyStatus[] {
  return SPEECH_ENV_KEYS.map((field) => validateKeyField(field, env[field.envVar]));
}
