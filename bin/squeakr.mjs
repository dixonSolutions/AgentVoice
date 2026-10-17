#!/usr/bin/env node
// Pre-rename path (docs/46): service units written by Squeakr run
// `node <install>/bin/squeakr.mjs run`. Kept so a clone that pulls the
// rename keeps its service running until `squeaky upgrade-from-squeakr`
// rewrites the unit. Not a published command — package.json#bin is `squeaky`
// (a global `squeakr` package would collide on the bin link).
await import('./squeaky.mjs');
