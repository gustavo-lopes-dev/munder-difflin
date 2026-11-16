'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const loadTs = require('./load-ts.cjs');

const helper = path.resolve(__dirname, '../resources/md-slack-reply.cjs');

function runMcp(agentDir, requests) {
  const result = spawnSync(
    process.execPath,
    [helper, '--mcp', '--agent-dir', agentDir],
    {
      input:
        requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 5000,
      // No node, bwrap, shell, credentials, or loopback discovery on PATH/env.
      env: { PATH: '/nonexistent', ELECTRON_RUN_AS_NODE: '1' }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('Slack MCP queues a reply without a shell, bubblewrap, token, or loopback', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-slack-mcp-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = {
    channel: 'C123TEST',
    thread_ts: '1794845711.225149',
    text: '*Resposta*\nSou Michael.'
  };
  const responses = runMcp(temp, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' }
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'reply', arguments: input }
    }
  ]);
  assert.equal(
    responses.length,
    3,
    'notifications must not produce responses or stdout logging'
  );
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.equal(responses[1].result.tools[0].name, 'reply');
  assert.equal(responses[2].result.isError, false);
  assert.match(responses[2].result.content[0].text, /Queued.*asynchronous/);
  const pending = path.join(temp, 'slack-replies/pending');
  const files = fs.readdirSync(pending);
  assert.equal(files.length, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(pending, files[0]), 'utf8')),
    { ...input, attempts: 0 }
  );
});

test('Slack MCP rejects invalid destinations, blank/oversized messages and unknown tools', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-slack-mcp-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const valid = {
    channel: 'C123TEST',
    thread_ts: '1794845711.225149',
    text: 'Resposta'
  };
  const responses = runMcp(temp, [
    ...[
      { channel: '' },
      { thread_ts: '' },
      { text: '  ' },
      { text: 'x'.repeat(40001) }
    ].map((patch, id) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'reply', arguments: { ...valid, ...patch } }
    })),
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'exec', arguments: valid }
    }
  ]);
  assert.equal(responses.length, 5);
  for (const response of responses) assert.equal(response.result.isError, true);
  assert.equal(fs.existsSync(path.join(temp, 'slack-replies')), false);
});

test('Codex receives a per-agent host MCP config without changing sandbox policy', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-slack-mcp-config-'));
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = temp;
  process.env.USERPROFILE = temp;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => temp);
  const agentDir = path.join(temp, 'hive/agents/michael');
  const injection = await hive.ensureAgent(
    { id: 'michael', name: 'Michael', provider: 'codex', cwd: temp },
    { slackReplyScript: helper }
  );
  const config = fs.readFileSync(
    path.join(injection.env.CODEX_HOME, 'config.toml'),
    'utf8'
  );
  assert.match(config, /\[mcp_servers\.munder_slack\]/);
  assert.ok(config.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(
    config.includes(
      `args = ${JSON.stringify([helper, '--mcp', '--agent-dir', agentDir])}`
    )
  );
  assert.match(config, /ELECTRON_RUN_AS_NODE = "1"/);
  assert.match(config, /enabled_tools = \["reply"\]/);
  assert.match(
    config,
    /\[mcp_servers\.munder_slack\.tools\.reply\]\napproval_mode = "approve"/
  );
  assert.ok(
    !config.includes('default_tools_approval_mode'),
    'other tools must not be preapproved'
  );
  assert.ok(!config.includes('danger-full-access'));
  assert.ok(!config.includes('sandbox_mode'));
});
