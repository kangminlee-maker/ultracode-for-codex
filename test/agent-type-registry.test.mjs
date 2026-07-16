import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { loadAgentTypeRegistry, parseAgentTypeToml, readTomlString } from '../dist/codex/agent-type-registry.js';

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-types-'));
  tempDirs.push(dir);
  return dir;
}

test('parseAgentTypeToml extracts the three consumed scalars and trims the leading multiline newline', () => {
  const text = [
    'name = "reviewer"',
    'description = "Adversarial review."',
    'model = "gpt-5.6-terra"',
    'model_reasoning_effort = "high"',
    'sandbox_mode = "read-only"',
    '',
    'developer_instructions = """',
    'Line one.',
    'Line two.',
    '"""',
    '',
  ].join('\n');
  const parsed = parseAgentTypeToml(text);
  assert.equal(parsed.model, 'gpt-5.6-terra');
  assert.equal(parsed.effort, 'high');
  // The newline immediately after the opening """ is trimmed (TOML spec); the trailing newline before
  // the closing delimiter is kept verbatim.
  assert.equal(parsed.developerInstructions, 'Line one.\nLine two.\n');
});

test('parseAgentTypeToml is lenient: ignores unknown keys, non-string scalars, arrays, comments, and stops at the first table', () => {
  const text = [
    '# a leading comment',
    'model = "m1" # trailing comment',
    'temperature = 0.7',      // non-string scalar → ignored
    'enabled = true',          // bool → ignored
    'tools = ["a", "b"]',      // array → ignored
    'developer_instructions = "persona # not a comment"', // # inside a string is literal
    '',
    '[extra]',                 // first table → stop; keys below must NOT be read
    'model = "should-not-win"',
  ].join('\n');
  const parsed = parseAgentTypeToml(text);
  assert.equal(parsed.model, 'm1');
  assert.equal(parsed.effort, undefined);
  assert.equal(parsed.developerInstructions, 'persona # not a comment');
});

test('parseAgentTypeToml handles CRLF and literal (single-quote) strings, first occurrence wins', () => {
  const text = 'model = \'gpt-x\'\r\nmodel = "second"\r\ndeveloper_instructions = \'\'\'raw\\nverbatim\'\'\'\r\n';
  const parsed = parseAgentTypeToml(text);
  assert.equal(parsed.model, 'gpt-x'); // first wins; CRLF stripped
  // Literal strings are verbatim: the backslash-n is two characters, not a newline.
  assert.equal(parsed.developerInstructions, 'raw\\nverbatim');
});

test('parseAgentTypeToml never throws on garbage and yields {}', () => {
  assert.deepEqual(parseAgentTypeToml('=== not toml @@@\n\x00\x01'), {});
  assert.deepEqual(parseAgentTypeToml(''), {});
  assert.deepEqual(parseAgentTypeToml('model = '), {}); // dangling value
  assert.deepEqual(parseAgentTypeToml('model = "unterminated'), {}); // unterminated string
});

test('readTomlString processes basic escapes but leaves literal strings verbatim', () => {
  assert.equal(readTomlString('"a\\nb\\tc"', 0)?.value, 'a\nb\tc');
  assert.equal(readTomlString("'a\\nb'", 0)?.value, 'a\\nb');
  assert.equal(readTomlString('"""\nx"""', 0)?.value, 'x');
  assert.equal(readTomlString('"no end', 0), null);
});

test('loadAgentTypeRegistry keys by filename stem and skips files with no usable keys', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'reviewer.toml'), 'model = "m"\ndeveloper_instructions = "review"\n');
  await writeFile(join(dir, 'sweep.toml'), 'model = "s"\nmodel_reasoning_effort = "low"\n');
  await writeFile(join(dir, 'empty.toml'), '# only a comment, no usable keys\n');
  await writeFile(join(dir, 'notes.txt'), 'model = "ignored non-toml"\n');
  const { registry, warnings } = await loadAgentTypeRegistry(dir);
  assert.deepEqual([...registry.keys()].sort(), ['reviewer', 'sweep']);
  assert.deepEqual(registry.get('reviewer'), { name: 'reviewer', model: 'm', developerInstructions: 'review' });
  assert.deepEqual(registry.get('sweep'), { name: 'sweep', model: 's', effort: 'low' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /empty.*no model/);
});

test('loadAgentTypeRegistry returns an empty registry for a missing directory', async () => {
  const { registry, warnings } = await loadAgentTypeRegistry(join(await tempDir(), 'does-not-exist'));
  assert.equal(registry.size, 0);
  assert.deepEqual(warnings, []);
});

test('loadAgentTypeRegistry skips an oversized file rather than aborting the whole load', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'good.toml'), 'model = "m"\n');
  await writeFile(join(dir, 'huge.toml'), `developer_instructions = "${'x'.repeat(70 * 1024)}"\n`);
  const { registry, warnings } = await loadAgentTypeRegistry(dir);
  assert.deepEqual([...registry.keys()], ['good']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /huge.*exceeds/);
});
