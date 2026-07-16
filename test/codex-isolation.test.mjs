import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  codexContextIsolationArgs,
  createCodexIsolation,
  minimalCodexConfigToml,
  sliceMcpServerSections,
} from '../dist/codex/subagent-backend.js';

// A hand-written multi-server config.toml fixture (NOT the user's real config) — includes a prefix
// trap (`ontology_docs` must not match `onto`), a subtable server (`node_repl.env`), a hyphenated
// name, and a non-mcp section to prove sections outside the allowlist are never sliced.
const MCP_FIXTURE_TOML = [
  'model = "gpt-fixture"',
  '',
  '[mcp_servers.onto]',
  'command = "/opt/homebrew/bin/onto"',
  'args = ["mcp"]',
  '',
  '[mcp_servers.ontology_docs]',
  'command = "/opt/od"',
  '',
  '[mcp_servers.node_repl]',
  'command = "/n/node_repl"',
  'startup_timeout_sec = 120',
  '',
  '[mcp_servers.node_repl.env]',
  'CODEX_HOME = "/home/x/.codex"',
  '',
  '[mcp_servers.day1-mcp]',
  'command = "/d/day1-mcp"',
  'cwd = "/home/x"',
  '',
  '[other]',
  'z = 1',
  '',
].join('\n');

const originalCodexHome = process.env.CODEX_HOME;
const tempDirs = [];

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('Codex isolation copies auth and writes deterministic workflow-only config', async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-source-home-'));
  tempDirs.push(sourceHome);
  process.env.CODEX_HOME = sourceHome;
  await writeFile(join(sourceHome, 'auth.json'), '{"token":"secret"}\n');
  await writeFile(join(sourceHome, 'config.toml'), 'model = "gpt-source-model"\n');
  await mkdir(join(sourceHome, 'plugins'), { recursive: true });
  await writeFile(join(sourceHome, 'plugins', 'ignored.json'), '{}\n');

  const isolation = await createCodexIsolation({
    reasoningEffort: 'xhigh',
    verbosity: 'medium',
  });
  tempDirs.push(isolation.rootDir);

  assert.equal(isolation.defaultModel, 'gpt-source-model');
  assert.equal(await readFile(join(isolation.homeDir, 'auth.json'), 'utf8'), '{"token":"secret"}\n');
  await assert.rejects(() => readFile(join(isolation.homeDir, 'plugins', 'ignored.json'), 'utf8'));
  const config = await readFile(join(isolation.homeDir, 'config.toml'), 'utf8');
  assert.match(config, /model = "gpt-source-model"/);
  assert.match(config, /model_reasoning_effort = "xhigh"/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /image_generation = false/);
  assert.match(config, /\[features\.multi_agent_v2\]\nmax_concurrent_threads_per_session = 1/);
  assert.match(config, /Native subagent delegation is unavailable/);
  assert.match(config, /\[shell_environment_policy\]\ninherit = "none"/);
});

test('Codex app-server args pin runtime-owned config overrides', () => {
  const args = codexContextIsolationArgs({
    model: 'gpt-args-model',
    reasoningEffort: 'high',
    verbosity: 'low',
  }).join('\n');

  assert.match(args, /model="gpt-args-model"/);
  assert.match(args, /model_reasoning_effort="high"/);
  assert.match(args, /model_verbosity="low"/);
  assert.match(args, /web_search="disabled"/);
  assert.match(args, /shell_environment_policy\.inherit="none"/);
  assert.match(args, /features\.image_generation=false/);
  assert.match(args, /features\.multi_agent_v2\.max_concurrent_threads_per_session=1/);
  assert.match(args, /features\.multi_agent_v2\.multi_agent_mode_hint_text=/);
});

test('minimal Codex config is workflow-only and side-effect constrained', () => {
  const toml = minimalCodexConfigToml({
    model: 'gpt-config-model',
    reasoningEffort: 'xhigh',
    verbosity: 'high',
  });

  assert.match(toml, /model = "gpt-config-model"/);
  assert.match(toml, /model_reasoning_effort = "xhigh"/);
  assert.match(toml, /model_verbosity = "high"/);
  assert.match(toml, /approval_policy = "never"/);
  assert.match(toml, /sandbox_mode = "read-only"/);
  assert.match(toml, /web_search = "disabled"/);
  assert.match(toml, /image_generation = false/);
  assert.match(toml, /max_concurrent_threads_per_session = 1/);
});

test('agent-web-search gate flips web_search across every isolation config site', async () => {
  // Default-off byte-identical: omitting webSearch (and passing false) both emit "disabled".
  for (const webSearch of [undefined, false]) {
    assert.match(
      codexContextIsolationArgs({ reasoningEffort: 'high', verbosity: 'low', webSearch }).join('\n'),
      /web_search="disabled"/,
    );
    assert.match(
      minimalCodexConfigToml({ reasoningEffort: 'xhigh', verbosity: 'high', webSearch }),
      /web_search = "disabled"/,
    );
  }
  // Enabled: the same knob flips to "live" at both standalone config sites.
  assert.match(
    codexContextIsolationArgs({ reasoningEffort: 'high', verbosity: 'low', webSearch: true }).join('\n'),
    /web_search="live"/,
  );
  assert.match(
    minimalCodexConfigToml({ reasoningEffort: 'xhigh', verbosity: 'high', webSearch: true }),
    /web_search = "live"/,
  );

  // And through createCodexIsolation's written config.toml (the home-config site).
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-source-home-web-'));
  tempDirs.push(sourceHome);
  process.env.CODEX_HOME = sourceHome;
  await writeFile(join(sourceHome, 'auth.json'), '{"token":"secret"}\n');
  const isolation = await createCodexIsolation({ reasoningEffort: 'low', verbosity: 'low', webSearch: true });
  tempDirs.push(isolation.rootDir);
  assert.match(await readFile(join(isolation.homeDir, 'config.toml'), 'utf8'), /web_search = "live"/);
});

test('sliceMcpServerSections extracts allowlisted servers verbatim and segment-exact (W1)', () => {
  // Single server → exactly its block, nothing else.
  let r = sliceMcpServerSections(MCP_FIXTURE_TOML, ['onto']);
  assert.deepEqual([...r.found], ['onto']);
  assert.match(r.block, /\[mcp_servers\.onto\]/);
  assert.match(r.block, /command = "\/opt\/homebrew\/bin\/onto"/);
  assert.doesNotMatch(r.block, /\[other\]/);
  // Prefix-negative (design-verify F2): `onto` must NOT slice `ontology_docs`.
  assert.doesNotMatch(r.block, /ontology_docs/);

  // Multi-subtable server carries its `.env` subtable.
  r = sliceMcpServerSections(MCP_FIXTURE_TOML, ['node_repl']);
  assert.match(r.block, /\[mcp_servers\.node_repl\]/);
  assert.match(r.block, /\[mcp_servers\.node_repl\.env\]/);
  assert.match(r.block, /CODEX_HOME = "\/home\/x\/\.codex"/);

  // Hyphenated bare name + multiple names.
  r = sliceMcpServerSections(MCP_FIXTURE_TOML, ['onto', 'day1-mcp']);
  assert.deepEqual([...r.found].sort(), ['day1-mcp', 'onto']);
  assert.match(r.block, /\[mcp_servers\.day1-mcp\]/);

  // A name with no matching table header is reported missing (empty block, empty found).
  r = sliceMcpServerSections(MCP_FIXTURE_TOML, ['ghost']);
  assert.equal(r.found.size, 0);
  assert.equal(r.block, '');

  // An array-of-tables `[[...]]` between the allowlisted section and EOF (or the next single-bracket
  // table) must terminate the mcp section — it must NOT be swallowed into the slice (bot review P2).
  const withArrayTable = [
    '[mcp_servers.foo]',
    'command = "x"',
    '[[skills.config]]',
    'name = "UNRELATED"',
    'path = "/etc"',
  ].join('\n');
  r = sliceMcpServerSections(withArrayTable, ['foo']);
  assert.deepEqual([...r.found], ['foo']);
  assert.match(r.block, /\[mcp_servers\.foo\]/);
  assert.doesNotMatch(r.block, /UNRELATED/);
  assert.doesNotMatch(r.block, /skills\.config/);
});

test('MCP allowlist provisions verbatim sections; default-off is byte-identical; unknown fails loud (W2)', async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-source-home-mcp-'));
  tempDirs.push(sourceHome);
  process.env.CODEX_HOME = sourceHome;
  await writeFile(join(sourceHome, 'auth.json'), '{"token":"secret"}\n');
  await writeFile(join(sourceHome, 'config.toml'), MCP_FIXTURE_TOML);

  // Enabled: the allowlisted section appears verbatim in the isolated config.
  const on = await createCodexIsolation({ reasoningEffort: 'low', verbosity: 'low', mcpServers: ['onto'] });
  tempDirs.push(on.rootDir);
  const onConfig = await readFile(join(on.homeDir, 'config.toml'), 'utf8');
  assert.match(onConfig, /\[mcp_servers\.onto\]/);
  assert.match(onConfig, /command = "\/opt\/homebrew\/bin\/onto"/);
  assert.doesNotMatch(onConfig, /ontology_docs/);

  // Default-off byte-identical: empty list and omitted both produce a config with no [mcp_servers.
  const emptyList = await createCodexIsolation({ reasoningEffort: 'low', verbosity: 'low', mcpServers: [] });
  tempDirs.push(emptyList.rootDir);
  const omitted = await createCodexIsolation({ reasoningEffort: 'low', verbosity: 'low' });
  tempDirs.push(omitted.rootDir);
  const emptyConfig = await readFile(join(emptyList.homeDir, 'config.toml'), 'utf8');
  const omittedConfig = await readFile(join(omitted.homeDir, 'config.toml'), 'utf8');
  assert.doesNotMatch(emptyConfig, /\[mcp_servers/);
  assert.equal(emptyConfig, omittedConfig);

  // An allowlisted name with no section fails loud at isolation setup (never a silent no-op).
  await assert.rejects(
    () => createCodexIsolation({ reasoningEffort: 'low', verbosity: 'low', mcpServers: ['ghost'] }),
    /Unknown MCP server/,
  );
});
