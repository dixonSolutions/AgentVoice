#!/usr/bin/env node
// Pre-rename path (docs/45): service units written by AgentVoice run
// `node <install>/bin/agentvoice.mjs run`. Kept so a clone that pulls the
// rename keeps its service running until `squeakr upgrade-from-agentvoice`
// rewrites the unit. Not a published command — package.json#bin is `squeakr`.
await import('./squeakr.mjs');
