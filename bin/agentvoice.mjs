#!/usr/bin/env node
// Pre-rename path (docs/45): service units written by AgentVoice run
// `node <install>/bin/agentvoice.mjs run`. Kept so a clone that pulls the
// rename keeps its service running until `squeaky upgrade-from-squeakr`
// rewrites the unit. Not a published command — package.json#bin is `squeaky`.
await import('./squeaky.mjs');
