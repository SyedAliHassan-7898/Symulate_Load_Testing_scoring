#!/usr/bin/env node

// scripts/run.js
//
// Reads .env from the project root and passes every variable to k6 via -e
// flags so __ENV in k6 scripts picks them up.  k6 does NOT read .env files
// on its own — this runner bridges that gap.
//
// Usage (called from npm scripts, not directly):
//   node scripts/run.js tests/smoke.js
//   node scripts/run.js tests/smoke.js LOAD_MODE=load ANUM_API_ENABLED=false
//
// Extra KEY=VALUE args after the script path are merged on top of .env,
// so npm scripts can override specific values without touching .env.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- 1. Parse .env -----------------------------------------------------------
const envPath = path.resolve(__dirname, '..', '.env');
const env = {};

if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8')
    .split('\n')
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes if present
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    });
}

// --- 2. Merge extra overrides from CLI args ----------------------------------
const args = process.argv.slice(2);
const scriptArgs = [];
let expectValue = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  // If the previous arg was a flag that expects a value, pass this arg through
  if (expectValue) {
    scriptArgs.push(arg);
    expectValue = false;
    continue;
  }
  if (arg.startsWith('--') || arg.startsWith('-')) {
    scriptArgs.push(arg);
    // Flags like --out, -o expect the next arg as their value
    if (arg === '--out' || arg === '-o') expectValue = true;
  } else if (arg.includes('=') && !arg.endsWith('.js')) {
    const eqIdx = arg.indexOf('=');
    env[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
  } else {
    scriptArgs.push(arg);
  }
}

// --- 3. Build k6 -e flags ---------------------------------------------------
const k6Args = [];
for (const [key, value] of Object.entries(env)) {
  k6Args.push('-e', `${key}=${value}`);
}
k6Args.push(...scriptArgs);

// --- 4. Log what we're running -----------------------------------------------
const mode = env.LOAD_MODE || 'smoke';
const vus = env.LOAD_VUS || '?';
const duration = env.LOAD_DURATION || '?';
const anum = env.ANUM_API_ENABLED || '?';
console.log(`[runner] mode=${mode}  vus=${vus}  duration=${duration}  anum=${anum}`);
console.log(`[runner] k6 ${k6Args.join(' ')}`);

// --- 5. Spawn k6 -------------------------------------------------------------
const cmd = ['k6', 'run', ...k6Args].join(' ');
const child = spawn(cmd, [], {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => process.exit(code || 0));
