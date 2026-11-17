#!/usr/bin/env node
'use strict';

// Explicit, opt-in external-assistant consultation. Only talks to Munder's
// authenticated loopback broker; never reads/receives the Slack bot token.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [name, ...rest] = argv[i].slice(2).split('=');
    args[name] = rest.length ? rest.join('=') : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function configFile(args) {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') :
    process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return args.config || process.env.MD_SLACK_REPLY_CONFIG || (base && path.join(base, 'munder-difflin', 'slack-reply.json'));
}

function callBroker(args, method, route, input) {
  return new Promise((resolve, reject) => {
    let config;
    try { config = JSON.parse(fs.readFileSync(configFile(args), 'utf8')); }
    catch { reject(new Error('Munder Slack bridge is not running. Start Slack integration or provide --config <slack-reply.json>.')); return; }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== 'string' || !config.token) {
      reject(new Error('Invalid Munder discovery file')); return;
    }
    const body = input ? JSON.stringify(input) : '';
    const req = http.request({ host: '127.0.0.1', port: config.port, path: route, method,
      headers: { 'x-md-reply-token': config.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('Broker response too large')); else chunks.push(chunk); });
      res.on('error', () => reject(new Error('Broker response interrupted')));
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || !result.ok) throw new Error(result.error || 'Consultation request rejected');
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('Broker timed out. Query status using the SAME consultation id; do not create a new question.')));
    req.on('error', reject); req.end(body);
  });
}

const recipientSchema = {
  oneOf: [
    { type: 'object', properties: { kind: { const: 'hive' }, id: { type: 'string' } }, required: ['kind', 'id'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'opencode' }, id: { type: 'string' }, directory: { type: 'string' } }, required: ['kind', 'id', 'directory'], additionalProperties: false }
  ]
};

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: md-slack-consult.cjs --question "..." --context "ticket / scenario" --orchestrator-session ses_... [--requester-session ses_...] [--directory /project] [--id retry-key] [--config /path/slack-reply.json]\nHive: use --orchestrator-agent god [--requester-agent worker].\nStatus: --status <consultation-id>. Redeliver updates only: --retry-notifications <id>. MCP: --mcp. Destinations/assistant/deadline are configured in Munder Settings → Slack.');
    return;
  }
  if (args.mcp) {
    const readline = require('node:readline').createInterface({ input: process.stdin });
    for await (const line of readline) {
      let request;
      try {
        if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Input too large');
        request = JSON.parse(line);
        if (request.id === undefined) continue;
        let result;
        if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'munder-slack-consult', version: '1.0.0' } };
        else if (request.method === 'ping') result = {};
        else if (request.method === 'tools/list') result = { tools: [
          { name: 'consult', description: 'Ask the configured external Slack assistant. Posts externally; requires permission to share the question. Returns a consultation id, not the answer. Munder asynchronously notifies the specified orchestrator/requester when a reply or timeout arrives. Reuse id on retries.', inputSchema: {
            type: 'object', properties: { id: { type: 'string' }, question: { type: 'string', maxLength: 12000 }, context: { type: 'string', maxLength: 2000 }, orchestrator: recipientSchema, requester: recipientSchema }, required: ['id', 'question', 'orchestrator'], additionalProperties: false
          }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
          { name: 'status', description: 'Read local consultation status, replies and recipient delivery errors. Does not query or post to Slack.', inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,100}$' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
          { name: 'retry_notifications', description: 'Retry unconfirmed orchestrator/requester updates after fixing their session/agent. Never reposts the Slack question.', inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,100}$' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
        ] };
        else if (request.method === 'tools/call') {
          const input = request.params?.arguments;
          let response;
          if (request.params?.name === 'consult') response = await callBroker(args, 'POST', '/consultations', input);
          else if (request.params?.name === 'status' && /^[a-zA-Z0-9_-]{8,100}$/.test(input?.id ?? '')) response = await callBroker(args, 'GET', `/consultations/${input.id}`);
          else if (request.params?.name === 'retry_notifications' && /^[a-zA-Z0-9_-]{8,100}$/.test(input?.id ?? '')) response = await callBroker(args, 'POST', `/consultations/${input.id}/retry-notifications`);
          else throw new Error('Unknown tool or invalid consultation id');
          result = { content: [{ type: 'text', text: JSON.stringify(response) }] };
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue;
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, result: { isError: true, content: [{ type: 'text', text: error.message }] } }) + '\n');
      }
    }
    return;
  }
  if (typeof args.status === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(args.status)) {
    console.log(JSON.stringify(await callBroker(args, 'GET', `/consultations/${args.status}`), null, 2)); return;
  }
  if (typeof args['retry-notifications'] === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(args['retry-notifications'])) {
    console.log(JSON.stringify(await callBroker(args, 'POST', `/consultations/${args['retry-notifications']}/retry-notifications`), null, 2)); return;
  }
  if (typeof args.question !== 'string' || !args.question.trim()) throw new Error('Use --question "..." or --help');
  const directory = path.resolve(typeof args.directory === 'string' ? args.directory : process.cwd());
  const target = (session, agent, overrideDirectory) => typeof session === 'string' ? { kind: 'opencode', id: session, directory: typeof overrideDirectory === 'string' ? path.resolve(overrideDirectory) : directory } : typeof agent === 'string' ? { kind: 'hive', id: agent } : undefined;
  const orchestrator = target(args['orchestrator-session'], args['orchestrator-agent'] || (process.env.HIVE_ROOT ? 'god' : undefined), args['orchestrator-directory']);
  if (!orchestrator) throw new Error('An orchestrator recipient is required: --orchestrator-session ses_... or --orchestrator-agent <id>');
  const id = typeof args.id === 'string' ? args.id : randomUUID();
  // Print the id BEFORE sending: even a process interruption has a recovery key.
  process.stderr.write(`Consultation id: ${id}\n`);
  const result = await callBroker(args, 'POST', '/consultations', {
    id, question: args.question, context: typeof args.context === 'string' ? args.context : undefined,
    orchestrator, requester: target(args['requester-session'], args['requester-agent'] || process.env.AGENT_ID, args['requester-directory'])
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { process.stderr.write(`md-slack-consult: ${error.message}\n`); process.exitCode = 1; });
