#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const providerEndpointSegment = ['ap', 'i'].join('');

const runtimeRoots = ['src', 'dist'];
const requiredRuntimeFiles = [
  'src/cli.ts',
  'src/codex/env.ts',
  'src/codex/model-catalog.ts',
  'src/codex/subagent-backend.ts',
  'src/runtime/package-info.ts',
  'src/runtime/workflow-runtime.ts',
  'src/runtime/workflow-journal.ts',
  'dist/cli.js',
  'dist/codex/env.js',
  'dist/codex/model-catalog.js',
  'dist/codex/subagent-backend.js',
  'dist/runtime/package-info.js',
  'dist/runtime/workflow-runtime.js',
  'dist/runtime/workflow-journal.js',
];

const currentRuntimeFiles = new Set([
  'src/cli.ts',
  'src/settings.ts',
  'src/ultracode-install-guide.ts',
  'src/codex/env.ts',
  'src/codex/model-catalog.ts',
  'src/codex/subagent-backend.ts',
  'src/codex/setup-probe.ts',
  'src/codex/turn-failure.ts',
  'src/runtime/async-queue.ts',
  'src/runtime/agent-concurrency-pool.ts',
  'src/runtime/package-info.ts',
  'src/runtime/state-root.ts',
  'src/runtime/types.ts',
  'src/runtime/workflow-runtime.ts',
  'src/runtime/workflow-journal.ts',
  'dist/cli.d.ts',
  'dist/cli.js',
  'dist/settings.d.ts',
  'dist/settings.js',
  'dist/ultracode-install-guide.d.ts',
  'dist/ultracode-install-guide.js',
  'dist/codex/env.d.ts',
  'dist/codex/env.js',
  'dist/codex/model-catalog.d.ts',
  'dist/codex/model-catalog.js',
  'dist/codex/subagent-backend.d.ts',
  'dist/codex/subagent-backend.js',
  'dist/codex/setup-probe.d.ts',
  'dist/codex/setup-probe.js',
  'dist/codex/turn-failure.d.ts',
  'dist/codex/turn-failure.js',
  'dist/runtime/async-queue.d.ts',
  'dist/runtime/async-queue.js',
  'dist/runtime/agent-concurrency-pool.d.ts',
  'dist/runtime/agent-concurrency-pool.js',
  'dist/runtime/package-info.d.ts',
  'dist/runtime/package-info.js',
  'dist/runtime/state-root.d.ts',
  'dist/runtime/state-root.js',
  'dist/runtime/types.d.ts',
  'dist/runtime/types.js',
  'dist/runtime/workflow-runtime.d.ts',
  'dist/runtime/workflow-runtime.js',
  'dist/runtime/workflow-journal.d.ts',
  'dist/runtime/workflow-journal.js',
]);

const sourceOnlyChecks = [
  {
    name: 'runtime source must not use outbound fetch',
    pattern: /\bfetch\s*\(/,
    allow: [],
  },
  {
    name: 'runtime source must not use outbound network clients',
    pattern: /\b(?:https?|net|tls)\.(?:request|get|connect)\s*\(/,
    allow: [],
  },
  {
    name: 'runtime source must not create event-stream outbound clients',
    pattern: /\b(?:WebSocket|EventSource)\s*\(/,
    allow: [],
  },
  {
    name: 'runtime source must not pass ambient env wholesale',
    pattern: /(?:\.\.\.process\.env|env\s*:\s*process\.env)/,
    allow: [],
  },
];

const runtimeChecks = [
  {
    name: 'runtime must not embed direct provider hosts',
    pattern: new RegExp(String.raw`(?:https:\/\/)?${providerEndpointSegment}\.(?:openai|anthropic)\.com|auth\.openai\.com\/oauth\/token|chatgpt\.com\/backend-${providerEndpointSegment}\/codex`),
    allow: [],
  },
  {
    name: 'runtime must not read direct provider credential env names outside the Codex child-env sanitizer',
    pattern: /\b(?:OPENAI|ANTHROPIC|AZURE_OPENAI|OPENROUTER|GOOGLE|GEMINI|MISTRAL|GROQ|DEEPSEEK|COHERE|TOGETHER|PERPLEXITY|XAI)_(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|ORG_ID|ORGANIZATION|PROJECT|BASE_URL|API_BASE|ENDPOINT)\b/,
    allow: [
      'src/codex/env.ts',
      'dist/codex/env.js',
      'dist/codex/env.d.ts',
    ],
  },
  {
    name: 'runtime must not construct direct provider auth headers from process.env',
    pattern: new RegExp(String.raw`(?:Bearer\s+\$\{process\.env|x-${providerEndpointSegment}-key['"]?\s*:\s*process\.env)`),
    allow: [],
  },
];

const failures = [];

for (const filePath of requiredRuntimeFiles) {
  try {
    await stat(join(repoRoot, filePath));
  } catch {
    failures.push(`${filePath}: required runtime boundary file is missing`);
  }
}

for (const root of runtimeRoots) {
  const rootPath = join(repoRoot, root);
  try {
    await stat(rootPath);
  } catch {
    continue;
  }
  for await (const filePath of walk(rootPath)) {
    if (!/\.(?:ts|js|d\.ts)$/.test(filePath)) continue;
    const relativePath = relative(repoRoot, filePath);
    if (!currentRuntimeFiles.has(relativePath)) {
      failures.push(`${relativePath}: runtime file is outside the current CLI runtime surface`);
    }
    const content = await readFile(filePath, 'utf8');
    const checks = root === 'src'
      ? [...sourceOnlyChecks, ...runtimeChecks]
      : runtimeChecks;
    for (const check of checks) {
      if (check.allow.includes(relativePath)) continue;
      if (check.pattern.test(content)) failures.push(`${relativePath}: ${check.name}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Runtime boundary verification failed:\n${failures.map((item) => `- ${item}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('runtime boundary verification passed\n');

async function* walk(dir) {
  for (const name of await readdir(dir)) {
    const filePath = join(dir, name);
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      yield* walk(filePath);
    } else if (fileStat.isFile()) {
      yield filePath;
    }
  }
}
