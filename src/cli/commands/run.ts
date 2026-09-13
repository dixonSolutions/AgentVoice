/**
 * `agentvoice run` — boot the bridge in the foreground.
 *
 * This is what bare `agentvoice` has always done, and the seeding order below
 * is the contract a first-time install depends on: home, config, token, links,
 * chdir, native pre-flight, boot. Nothing here may become lazy — the bridge
 * resolves config.json and data/state.db relative to the cwd this sets.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkNativeBinding,
  envPath,
  link,
  nativeBindingAdvice,
  packageRoot,
  resolveHome,
  seedConfig,
  seedEnv,
} from '../home.js';
import { fail, say } from '../out.js';

export async function runCommand(): Promise<number | null> {
  const home = resolveHome();
  mkdirSync(home, { recursive: true });

  let seededConfig = false;
  try {
    seededConfig = seedConfig(home);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const newToken = seedEnv(home);

  link(home, 'web/dist');
  link(home, 'package.json');

  if (seededConfig || newToken) {
    const line = '─'.repeat(62);
    say(`\n${line}\n AgentVoice first run — bridge home: ${home}`);
    if (seededConfig) {
      say(' Created config.json from config.example.json. Edit it to add');
      say(' your projects (absolute paths) before your first voice turn.');
    }
    if (newToken) {
      say(`\n Your APP_TOKEN (saved to ${envPath(home)}):\n`);
      say(`   ${newToken}\n`);
      say(' Paste it into the web app when it asks you to pair.');
    }
    say(`${line}\n`);
  }

  process.chdir(home);

  // The bridge logs its own fatal errors and exits, so a try/catch around the
  // import below never sees a missing native binding. Look before booting.
  const bindingError = await checkNativeBinding();
  if (bindingError) {
    fail(`the bridge cannot open its database.\n\n  ${nativeBindingAdvice(bindingError) ?? bindingError}\n`);
    return 1;
  }

  const entry = join(packageRoot(), 'dist', 'index.js');
  try {
    await import(pathToFileURL(entry).href);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND') {
      fail(`${entry} is missing — this install is incomplete. Reinstall with: npm i -g agentvoice`);
      return 1;
    }
    const advice = nativeBindingAdvice(err instanceof Error ? err.message : String(err));
    if (advice) {
      fail(`the bridge cannot open its database.\n\n  ${advice}\n`);
      return 1;
    }
    throw err;
  }

  // null = "the bridge owns this process now" — never set an exit code, or the
  // process would tear down the server the moment the event loop settles.
  return null;
}
