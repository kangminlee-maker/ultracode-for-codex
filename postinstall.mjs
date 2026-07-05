#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));

try {
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

// Best-effort staleness notice for previously installed Codex skill commands.
// This never writes outside the package; updating stays an explicit command.
try {
  const codexHome = process.env.CODEX_HOME?.trim() ? process.env.CODEX_HOME : join(homedir(), '.codex');
  const states = ['ultracode-for-codex', 'ultracode-for-codex-cli'].map((name) => skillState(
    join(packageRoot, 'skills', name),
    join(codexHome, 'skills', name),
    name,
  ));
  if (states.includes('stale')) {
    process.stdout.write([
      '',
      'ultracode-for-codex: the Codex skill commands installed under',
      `${join(codexHome, 'skills')} are out of date with this package.`,
      'Update them with: npm exec -- ultracode-for-codex skills --install',
      '',
    ].join('\n'));
  } else if (states.includes('missing')) {
    process.stdout.write([
      '',
      'Install the Codex skill commands with: npm exec -- ultracode-for-codex skills --install',
      '',
    ].join('\n'));
  }
} catch {
  // Skill detection is advisory only; never fail the install for it.
}

function skillState(sourceDir, targetDir, name) {
  let targetSkill;
  try {
    targetSkill = readFileSync(join(targetDir, 'SKILL.md'), 'utf8');
  } catch {
    return 'missing';
  }
  if (!new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(targetSkill)) return 'unmanaged';
  const sourceFiles = listFiles(sourceDir, '');
  const targetFiles = listFiles(targetDir, '');
  if (sourceFiles.join('\n') !== targetFiles.join('\n')) return 'stale';
  for (const relativePath of sourceFiles) {
    let sourceText;
    let targetText;
    try {
      sourceText = readFileSync(join(sourceDir, relativePath));
      targetText = readFileSync(join(targetDir, relativePath));
    } catch {
      return 'stale';
    }
    if (!sourceText.equals(targetText)) return 'stale';
  }
  return 'current';
}

function listFiles(root, prefix) {
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}
