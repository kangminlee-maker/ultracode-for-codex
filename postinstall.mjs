#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const guide = readFileSync(join(packageRoot, 'ULTRACODE_INSTALL.md'), 'utf8');
  process.stdout.write([
    '',
    '=== ultracode-for-codex ULTRACODE INSTALL GUIDE START ===',
    guide.trimEnd(),
    '=== ultracode-for-codex ULTRACODE INSTALL GUIDE END ===',
    '',
    'Re-read later with: ultracode-for-codex --llm-guide',
    '',
  ].join('\n'));
} catch (err) {
  process.stderr.write(
    `ultracode-for-codex postinstall failed to read ULTRACODE_INSTALL.md: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
}
