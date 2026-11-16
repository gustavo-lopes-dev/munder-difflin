#!/usr/bin/env node
/**
 * md-slack-reply.cjs — post a message back into the Slack thread that triggered
 * an office run, WITHOUT ever handling the bot token.
 *
 * The Munder Difflin main process runs a loopback-only HTTP endpoint (bound to
 * 127.0.0.1, never tunneled) and writes its `{ port, token }` to a small
 * discovery file under the app's userData dir. This helper reads that file and
 * POSTs the reply to the endpoint, which holds the bot token and forwards to
 * Slack's chat.postMessage. The token never appears here, in the prompt, or in
 * any transcript.
 *
 * Usage:
 *   node md-slack-reply.cjs --channel C123 --thread 1700000000.000100 --text "..."
 *   (optional) --config /abs/path/to/slack-reply.json
 *   --mcp --agent-dir /abs/path/to/agent starts a stdio MCP tool. It queues
 *   replies for main without launching a sandboxed shell or handling a token.
 *
 * The discovery file is located via, in order: --config, then the
 * MD_SLACK_REPLY_CONFIG env var (injected into every agent by main).
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

/** Parse `--key value` and `--key=value` pairs from argv. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`md-slack-reply: ${msg}\n`);
  process.exit(1);
}

/**
 * Sandboxed Codex/Claude shells cannot always reach the host's loopback server
 * on Linux. Queue the narrowly-scoped reply under this agent's own writable
 * directory; Munder's main process drains it and holds the Slack token.
 */
function queueReply(
  channel,
  thread,
  text,
  agentDir = process.env.AGENT_DIR,
  announce = true
) {
  if (!agentDir || !path.isAbsolute(agentDir)) return false;
  try {
    const pending = path.join(agentDir, 'slack-replies', 'pending');
    fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}-${randomBytes(8).toString('hex')}`;
    const file = path.join(pending, `${id}.json`);
    const body = JSON.stringify({
      channel,
      thread_ts: thread,
      text,
      attempts: 0
    });
    if (Buffer.byteLength(body) > 64 * 1024) return false;
    fs.writeFileSync(file, body, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    if (announce)
      process.stdout.write('Queued Slack reply for Munder to deliver.\n');
    return true;
  } catch (e) {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.mcp) {
  startMcp(args['agent-dir'] || process.env.AGENT_DIR);
} else {
  const channel = args.channel;
  const thread = args.thread || args.thread_ts;
  const text = args.text;

  if (!channel || !thread || !text || text === true) {
    fail('required: --channel <id> --thread <ts> --text "<message>"');
  }

  const configPath = args.config || process.env.MD_SLACK_REPLY_CONFIG;
  if (!configPath) {
    if (queueReply(channel, thread, text)) process.exit(0);
    fail(
      'cannot locate the reply endpoint: set MD_SLACK_REPLY_CONFIG or pass --config'
    );
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    if (queueReply(channel, thread, text)) process.exit(0);
    fail(
      `reply endpoint not running (could not read ${configPath}): ${e.message}`
    );
  }
  if (!cfg || typeof cfg.port !== 'number' || typeof cfg.token !== 'string') {
    if (queueReply(channel, thread, text)) process.exit(0);
    fail(`malformed reply config at ${configPath}`);
  }

  const body = JSON.stringify({ channel, thread_ts: thread, text });
  const req = http.request(
    {
      method: 'POST',
      host: '127.0.0.1',
      port: cfg.port,
      path: '/reply',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-md-reply-token': cfg.token
      }
    },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try {
          json = JSON.parse(raw);
        } catch {
          /* non-JSON body */
        }
        if (res.statusCode === 200 && json.ok) {
          process.stdout.write('Posted reply to Slack thread.\n');
          process.exit(0);
        }
        if (queueReply(channel, thread, text)) process.exit(0);
        fail(
          `reply failed (HTTP ${res.statusCode}): ${json.error || raw || 'unknown error'}`
        );
      });
    }
  );
  req.on('error', (e) => {
    if (queueReply(channel, thread, text)) return;
    fail(`could not reach reply endpoint: ${e.message}`);
  });
  req.write(body);
  req.end();
}

/** MCP children run on the host, not inside Codex's shell sandbox. Expose only
 * the existing reply queue, never a general command runner or the bot token. */
function startMcp(agentDir) {
  if (typeof agentDir !== 'string' || !path.isAbsolute(agentDir)) {
    fail('MCP requires an absolute --agent-dir');
  }
  const lines = require('node:readline').createInterface({
    input: process.stdin
  });
  const send = (id, result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const error = (id, code, message) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
    );
  lines.on('line', (line) => {
    let request;
    try {
      if (Buffer.byteLength(line) > 256 * 1024) throw new Error('too large');
      request = JSON.parse(line);
    } catch {
      error(null, -32700, 'Invalid JSON request');
      return;
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      error(null, -32600, 'Invalid request');
      return;
    }
    if (request.id === undefined) return; // notifications/initialized, cancelled
    const { id, method, params } = request;
    if (method === 'initialize') {
      send(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'munder-slack', version: '1.0.0' }
      });
    } else if (method === 'ping') {
      send(id, {});
    } else if (method === 'tools/list') {
      send(id, {
        tools: [
          {
            name: 'reply',
            description:
              'Queue a substantive Slack thread reply for Munder to deliver. Use this instead of a shell command, including when bubblewrap/sandbox execution fails. Success means queued, not yet posted.',
            inputSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string', pattern: '^[A-Z0-9]{2,32}$' },
                thread_ts: { type: 'string', pattern: '^\\d{10}\\.\\d{6,}$' },
                text: { type: 'string', minLength: 1, maxLength: 40000 }
              },
              required: ['channel', 'thread_ts', 'text'],
              additionalProperties: false
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: true
            }
          }
        ]
      });
    } else if (method === 'tools/call') {
      const input = params?.arguments;
      if (
        params?.name !== 'reply' ||
        !input ||
        typeof input.channel !== 'string' ||
        !/^[A-Z0-9]{2,32}$/.test(input.channel) ||
        typeof input.thread_ts !== 'string' ||
        !/^\d{10}\.\d{6,}$/.test(input.thread_ts) ||
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        input.text.length > 40000
      ) {
        send(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Invalid reply: channel, thread_ts and non-empty text (max 40000 characters) required.'
            }
          ]
        });
        return;
      }
      const queued = queueReply(
        input.channel,
        input.thread_ts,
        input.text,
        agentDir,
        false
      );
      send(id, {
        isError: !queued,
        content: [
          {
            type: 'text',
            text: queued
              ? 'Queued Slack reply for Munder to deliver. Delivery is asynchronous.'
              : 'Could not write the Slack reply queue.'
          }
        ]
      });
    } else {
      error(id, -32601, 'Method not found');
    }
  });
}
