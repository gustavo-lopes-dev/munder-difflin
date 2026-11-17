'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { SlackReplyServer, postSlackQuestion, postSlackReply } = loadTs('src/main/slack.ts');
const { SlackConsultations } = loadTs('src/main/slackConsultations.ts');
const { notifyOpenCode } = loadTs('src/main/consultationNotifications.ts');

function child(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; }); p.stderr.on('data', (c) => { stderr += c; });
    p.on('error', reject); p.on('close', (code) => resolve({ code, stdout, stderr }));
    if (options.input) p.stdin.write(options.input); p.stdin.end();
  });
}

test('CLI → authenticated broker → real HTTP Slack stand-in → correlated response and status', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-consult-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const calls = [], updates = [];
  let mode = 'ok';
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls.push({ path: req.url, body: JSON.parse(raw), authorization: req.headers.authorization });
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(mode === 'ok' ? { ok: true, ts: '1700000000.000001', channel: 'CCONFIG123' } : { ok: false, error: 'missing_scope' }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => upstream.close());
  // Test-only transport routing to a local stand-in. The actual request body,
  // headers, response parser, socket errors and timeout code run unchanged;
  // TLS authentication against Slack itself is intentionally not exercised.
  const originalRequest = https.request;
  https.request = (options, callback) => http.request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }, callback);
  t.after(() => { https.request = originalRequest; });
  const settings = { enabled: true, channelId: 'CCONFIG123', assistantId: 'UCONFIG123', timeoutSeconds: 30 };
  const service = new SlackConsultations({ config: () => settings,
    post: (channel, text) => postSlackQuestion({ channel, text, botToken: 'test-only-secret' }),
    notify: async (recipient, text) => { updates.push({ recipient, text }); } });
  service.start(); t.after(() => service.stop());
  const broker = new SlackReplyServer({ token: 'test-only-capability', getBotToken: () => 'test-only-secret', consultations: service });
  const listening = await broker.start(); t.after(() => broker.stop());
  const discovery = path.join(tmp, 'slack-reply.json');
  fs.writeFileSync(discovery, JSON.stringify({ port: listening.port, token: 'test-only-capability' }), { mode: 0o600 });
  const helper = path.resolve('resources/md-slack-consult.cjs');
  const key = 'network-consultation-001';
  const args = [helper, '--config', discovery, '--id', key, '--question', 'How does this ERP flow work?', '--orchestrator-session', 'ses_Parent123', '--requester-session', 'ses_Child123', '--directory', tmp];
  const sent = await child(process.execPath, args);
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(JSON.parse(sent.stdout).consultation.status, 'waiting');
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/chat.postMessage');
  assert.equal(calls[0].body.channel, settings.channelId);
  assert.equal(calls[0].body.thread_ts, undefined, 'question is a new root, unlike the reply-only helper');
  assert.match(calls[0].body.text, /^<@UCONFIG123>/);
  assert.equal(calls[0].authorization, 'Bearer test-only-secret');
  assert.ok(!sent.stdout.includes('test-only-secret')); assert.ok(!sent.stdout.includes('test-only-capability'));
  assert.equal((await child(process.execPath, args)).code, 0); assert.equal(calls.length, 1);
  assert.equal(service.receive({ type: 'message', bot_id: 'BASSIST123', user: settings.assistantId, channel: settings.channelId,
    thread_ts: '1700000000.000001', ts: '1700000001.000002', text: 'A confirmed answer.' }, 'UOWN123'), true);
  await new Promise((resolve) => setImmediate(resolve));
  const status = await child(process.execPath, [helper, '--config', discovery, '--status', key]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).consultation.replies[0].text, 'A confirmed answer.');
  assert.equal(updates.length, 4, 'both parent and child receive sent and received updates');
  assert.deepEqual(updates.slice(2).map((u) => u.recipient.id), ['ses_Parent123', 'ses_Child123']);
  mode = 'reject';
  const denied = await postSlackQuestion({ channel: settings.channelId, text: 'x', botToken: 'test-only-secret' });
  assert.equal(denied.ok, false); assert.equal(denied.error, 'missing_scope');
  mode = 'disconnect';
  const uncertain = await postSlackQuestion({ channel: settings.channelId, text: 'x', botToken: 'test-only-secret' });
  assert.equal(uncertain.ok, false); assert.equal(uncertain.uncertain, true);
  const count = calls.length;
  assert.equal((await postSlackReply({ channel: settings.channelId, text: 'x', thread_ts: '', botToken: 'test-only-secret' })).ok, false);
  assert.equal(calls.length, count, 'existing root-post guard remains intact');
});

test('OpenCode updates use its real CLI process, directory and durable inbox contract (no shell interpolation)', { skip: process.platform === 'win32' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-opencode-notify-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const binary = path.join(tmp, 'opencode');
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync('admissions.jsonl',JSON.stringify(process.argv.slice(2))+'\\n'); console.log(JSON.stringify({data:{id:'msg_test_admitted'}}));\n`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = `${tmp}${path.delimiter}${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  const text = 'External response: $(must not run) "quotes"\nnext line';
  await notifyOpenCode({ kind: 'opencode', id: 'ses_ActualParent123', directory: tmp }, text, 'msg_consult_event_001');
  const args = JSON.parse(fs.readFileSync(path.join(tmp, 'admissions.jsonl'), 'utf8').trim());
  assert.deepEqual(args.slice(0, 3), ['api', 'post', '/api/session/ses_ActualParent123/prompt']);
  assert.deepEqual(JSON.parse(args[4]), { id: 'msg_consult_event_001', text, delivery: 'steer', resume: true });
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({error:{message:'not found'}}));\n`, { mode: 0o700 });
  await assert.rejects(notifyOpenCode({ kind: 'opencode', id: 'ses_Missing123', directory: tmp }, text, 'msg_consult_error_001'), /did not confirm/);
});

test('MCP exposes consultation/status without credentials or arbitrary Slack destinations', async (t) => {
  const listing = await child(process.execPath, [path.resolve('resources/md-slack-consult.cjs'), '--mcp'], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'
  });
  assert.equal(listing.code, 0, listing.stderr);
  const tools = JSON.parse(listing.stdout).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['consult', 'status', 'retry_notifications']);
  const schema = tools[0].inputSchema;
  assert.ok(schema.required.includes('orchestrator'));
  for (const forbidden of ['channel', 'assistantId', 'botToken', 'serverUrl']) assert.equal(schema.properties[forbidden], undefined);
});
