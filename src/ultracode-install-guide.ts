import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ULTRACODE_INSTALL_GUIDE_FILENAME = 'ULTRACODE_INSTALL.md';

export function readUltracodeInstallGuide(): string {
  return readFileSync(ultracodeInstallGuidePath(), 'utf8');
}

export function ultracodeInstallGuidePath(): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return join(distDir, '..', ULTRACODE_INSTALL_GUIDE_FILENAME);
}

export function renderUltracodeInstallGuideNotice(guide = readUltracodeInstallGuide()): string {
  return [
    '',
    '=== ultracode-for-codex ULTRACODE INSTALL GUIDE START ===',
    guide.trimEnd(),
    '=== ultracode-for-codex ULTRACODE INSTALL GUIDE END ===',
    '',
    `Re-read later with: ultracode-for-codex --llm-guide`,
    '',
  ].join('\n');
}
