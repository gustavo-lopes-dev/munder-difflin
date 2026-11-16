'use strict';

const assert = require('node:assert/strict');
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('Slack reply helper queues to the agent directory when loopback is unavailable', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'md-slack-reply-'));
  try {
    const agentDir = path.join(temp, 'agent');
    mkdirSync(agentDir);
    const config = path.join(temp, 'reply.json');
    // Port 1 has no listener; the helper must fall back to the agent-owned queue.
    writeFileSync(config, JSON.stringify({ port: 1, token: 'test-token' }));
    const helper = path.resolve(__dirname, '../resources/md-slack-reply.cjs');
    const result = spawnSync(
      process.execPath,
      [
        helper,
        '--channel',
        'C123TEST',
        '--thread',
        '1794843746.490579',
        '--text',
        'A substantive answer'
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          AGENT_DIR: agentDir,
          MD_SLACK_REPLY_CONFIG: config
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Queued Slack reply for Munder to deliver/);
    const pending = path.join(agentDir, 'slack-replies', 'pending');
    const files = readdirSync(pending).filter((file) => file.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(pending, files[0]), 'utf8')),
      {
        channel: 'C123TEST',
        thread_ts: '1794843746.490579',
        text: 'A substantive answer',
        attempts: 0
      }
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
