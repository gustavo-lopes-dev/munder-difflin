"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const http = require("node:http");
const loadTs = require("./load-ts.cjs");
const { SlackConsultations } = loadTs("src/main/slackConsultations.ts");
const { SlackWebhookServer, SlackReplyServer } = loadTs("src/main/slack.ts");
const { validateConsultationConfig, DEFAULT_SLACK_CONSULTATION } = loadTs(
  "src/shared/slackConsultation.ts",
);

const settings = {
  enabled: true,
  channelId: "CASSIST123",
  assistantId: "UASSIST123",
  timeoutSeconds: 15,
};
const question = {
  id: "consultation-test-001",
  question: "What prerequisites are required?",
  context: "ticket / scenario",
  orchestrator: {
    kind: "opencode",
    id: "ses_Orchestrator1",
    directory: "/project",
  },
  requester: { kind: "hive", id: "worker" },
};
const reply = {
  type: "message",
  subtype: "bot_message",
  channel: settings.channelId,
  thread_ts: "1700000000.000001",
  ts: "1700000001.000002",
  text: "Check accounting period first.",
  user: settings.assistantId,
  bot_id: "BASSIST123",
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, overrides = {}) {
  const posts = [],
    notices = [];
  let disk = [];
  const deps = {
    config: () => settings,
    post: async (channel, text) => {
      posts.push({ channel, text });
      return { ok: true, ts: reply.thread_ts };
    },
    notify: async (recipient, text, id) => {
      notices.push({ recipient, text, id });
    },
    save: (records) => {
      disk = structuredClone(records);
    },
    ...overrides,
  };
  const service = new SlackConsultations(deps);
  service.start();
  t.after(() => service.stop());
  return { service, posts, notices, deps, saved: () => disk };
}

test("consultation configuration is opt-in, generic, and rejects a group without an authenticated responder", () => {
  assert.equal(DEFAULT_SLACK_CONSULTATION.enabled, false);
  assert.equal(DEFAULT_SLACK_CONSULTATION.channelId, "");
  assert.equal(validateConsultationConfig(settings), undefined);
  assert.match(
    validateConsultationConfig({ ...settings, assistantId: "SGROUP123" }),
    /user group/,
  );
  assert.equal(
    validateConsultationConfig({
      ...settings,
      assistantId: "SGROUP123",
      responderId: "BASSIST123",
    }),
    undefined,
  );
  assert.ok(
    validateConsultationConfig({ ...settings, timeoutSeconds: Infinity }),
  );
});

test("posts once, pins destination, escapes user mentions, and notifies the actual orchestrator and requester", async (t) => {
  const f = fixture(t);
  const request = {
    ...question,
    question: "Explain <@UOTHER123> & prerequisites",
  };
  const result = await f.service.create(request);
  await tick();
  assert.equal(result.ok, true);
  assert.equal(result.consultation.status, "waiting");
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].channel, settings.channelId);
  assert.match(f.posts[0].text, /^<@UASSIST123>/);
  assert.match(f.posts[0].text, /&lt;@UOTHER123&gt; &amp;/);
  assert.equal((await f.service.create(request)).consultation.id, question.id);
  assert.equal(f.posts.length, 1, "same key cannot repost");
  assert.equal(
    (await f.service.create({ ...request, question: "different" })).ok,
    false,
  );
  assert.equal(f.notices.length, 2);
  assert.deepEqual(
    f.notices.map((n) => n.recipient),
    [question.orchestrator, question.requester],
  );
  assert.match(f.notices[0].text, /sent/);
  assert.equal(f.saved()[0].threadTs, reply.thread_ts);
});

test("disabled or malformed requests do not post or guess notification sessions", async (t) => {
  const f = fixture(t, { config: () => ({ ...settings, enabled: false }) });
  assert.equal((await f.service.create(question)).ok, false);
  assert.equal(
    (
      await f.service.create({
        ...question,
        orchestrator: { kind: "opencode", id: "../bad", directory: "/project" },
      })
    ).ok,
    false,
  );
  assert.equal(
    (await f.service.create({ ...question, orchestrator: undefined })).ok,
    false,
  );
  assert.equal(f.posts.length, 0);
});

test("only expected sender, channel and thread are accepted; duplicates and self-messages never loop", async (t) => {
  const f = fixture(t);
  await f.service.create(question);
  await tick();
  for (const altered of [
    { channel: "COTHER123" },
    { thread_ts: "1700000002.000005" },
    { user: "UOTHER123" },
    { subtype: "message_changed" },
    { text: "" },
  ]) {
    assert.equal(f.service.receive({ ...reply, ...altered }, "UOWN123"), false);
  }
  assert.equal(
    f.service.receive(reply, settings.assistantId),
    false,
    "own bot must never be its own assistant",
  );
  assert.equal(f.service.receive(reply, "UOWN123"), true);
  await tick();
  assert.equal(f.service.receive(reply, "UOWN123"), true);
  await tick();
  assert.equal(f.service.get(question.id).status, "received");
  assert.equal(f.service.get(question.id).replies.length, 1);
  assert.equal(
    f.notices.length,
    4,
    "one sent + one received event to each recipient",
  );
  assert.match(f.notices[2].text, /external, untrusted reference/);
  assert.equal(f.posts.length, 1, "a reply cannot send another Slack question");
});

test("bot/app identity is supported, and group mentions never authorize arbitrary group members", async (t) => {
  const f = fixture(t, {
    config: () => ({
      ...settings,
      assistantId: "SGROUP123",
      responderId: "BASSIST123",
    }),
  });
  await f.service.create(question);
  assert.match(f.posts[0].text, /^<!subteam\^SGROUP123>/);
  assert.equal(f.service.receive({ ...reply, user: undefined }), true);
  assert.equal(
    f.service.receive({
      ...reply,
      bot_id: "BOTHER123",
      user: "UOTHER123",
      ts: "1700000003.000003",
    }),
    false,
  );
});

test("two-step mode waits for the configured greeting, asks once in-thread, and only then accepts answers", async (t) => {
  const followups = [];
  const f = fixture(t, {
    config: () => ({
      ...settings,
      conversationMode: "mention_then_question",
      greetingText: "Ready to help.",
    }),
    postInThread: async (channel, thread, text) => {
      followups.push({ channel, thread, text });
      return { ok: true };
    },
  });
  await f.service.create(question);
  await tick();
  assert.equal(
    f.posts[0].text,
    "<@UASSIST123>",
    "opening message does not prematurely send the question",
  );
  const greeting = { ...reply, text: "Ready to help." };
  assert.equal(f.service.receive(greeting, "UOWN123"), true);
  await tick();
  assert.equal(f.service.receive(greeting, "UOWN123"), true);
  await tick();
  assert.equal(followups.length, 1);
  assert.equal(followups[0].thread, reply.thread_ts);
  assert.ok(followups[0].text.includes(question.question));
  assert.equal(f.service.get(question.id).status, "waiting");
  assert.equal(
    f.service.get(question.id).replies.length,
    0,
    "a greeting is not an ERP answer",
  );
  assert.equal(
    f.service.receive({ ...reply, ts: "1700000002.000003" }, "UOWN123"),
    true,
  );
  await tick();
  assert.equal(f.service.get(question.id).status, "received");
  assert.equal(
    f.notices.filter((n) => n.text.includes("consultation: question_sent"))
      .length,
    2,
  );
});

test("two-step greetings match a contained phrase ignoring case, without relaxing sender or thread checks", async (t) => {
  let sends = 0;
  const f = fixture(t, {
    config: () => ({
      ...settings,
      conversationMode: "mention_then_question",
      greetingText: "Como posso ajudar?",
    }),
    postInThread: async () => {
      sends++;
      return { ok: true };
    },
  });
  await f.service.create(question);
  await tick();
  const greeting = {
    ...reply,
    text: "Olá! COMO POSSO AJUDAR? Estou à disposição.",
  };
  for (const altered of [
    { text: "Olá! Estou à disposição." },
    { user: "UOTHER123", bot_id: "BOTHER123" },
    { thread_ts: "1700000002.000005" },
    { channel: "COTHER123" },
  ]) {
    f.service.receive({ ...greeting, ...altered }, "UOWN123");
    await tick();
    assert.equal(sends, 0);
  }
  f.service.receive(greeting, "UOWN123");
  await tick();
  f.service.receive(
    { ...greeting, text: "como posso ajudar?", ts: "1700000003.000003" },
    "UOWN123",
  );
  await tick();
  assert.equal(sends, 1, "greeting variations cannot resend the question");
  assert.equal(f.service.get(question.id).followupStatus, "sent");
  assert.equal(
    f.service.get(question.id).replies.length,
    0,
    "greetings are not ERP answers",
  );
});

test("an interrupted two-step question is not resent on greeting retries or restart", async (t) => {
  let sends = 0;
  const f = fixture(t, {
    config: () => ({
      ...settings,
      conversationMode: "mention_then_question",
      greetingText: "Ready to help.",
    }),
    postInThread: async () => {
      sends++;
      throw new Error("connection interrupted");
    },
  });
  await f.service.create(question);
  f.service.receive({ ...reply, text: "Ready to help." }, "UOWN123");
  await tick();
  f.service.receive({ ...reply, text: "Ready to help." }, "UOWN123");
  await tick();
  assert.equal(sends, 1);
  assert.equal(f.service.get(question.id).status, "delivery_unknown");
});

test("a late greeting after timeout cannot start sending a new thread question", async (t) => {
  let sends = 0;
  const old = {
    ...question,
    channel: settings.channelId,
    assistantId: settings.assistantId,
    responderId: settings.assistantId,
    conversationMode: "mention_then_question",
    greetingText: "Ready to help.",
    status: "waiting",
    createdAt: 100,
    deadline: 200,
    threadTs: reply.thread_ts,
    replies: [],
    notifications: [],
  };
  const f = fixture(t, {
    load: () => [old],
    now: () => 300,
    postInThread: async () => {
      sends++;
      return { ok: true };
    },
  });
  f.service.receive({ ...reply, text: "Ready to help." }, "UOWN123");
  await tick();
  assert.equal(sends, 0);
  assert.equal(f.service.get(question.id).status, "timed_out");
});

test("a failed ledger write does not lose the reply or poison deduplication on Slack retry", async (t) => {
  let fail = false;
  const f = fixture(t, {
    save: () => {
      if (fail) throw new Error("disk full");
    },
  });
  await f.service.create(question);
  await tick();
  fail = true;
  assert.throws(() => f.service.receive(reply, "UOWN123"), /disk full/);
  assert.equal(f.service.get(question.id).status, "waiting");
  assert.equal(f.service.get(question.id).replies.length, 0);
  fail = false;
  assert.equal(f.service.receive(reply, "UOWN123"), true);
  await tick();
  assert.equal(f.service.get(question.id).status, "received");
});

test("fast replies arriving before the send response are correlated after ts is known", async (t) => {
  let resolveSend;
  const f = fixture(t, {
    post: () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
  });
  const send = f.service.create(question);
  assert.equal(f.service.receive(reply, "UOWN123"), true);
  resolveSend({ ok: true, ts: reply.thread_ts });
  await send;
  await tick();
  assert.equal(f.service.get(question.id).status, "received");
  assert.equal(f.service.get(question.id).replies[0].text, reply.text);
  assert.deepEqual(
    f.notices.map((n) => n.text.match(/consultation: (\w+)/)?.[1]),
    ["sent", "sent", "received", "received"],
  );
});

test("timeout survives restart; late replies still notify without resending the question", async (t) => {
  const old = {
    ...question,
    channel: settings.channelId,
    assistantId: settings.assistantId,
    responderId: settings.assistantId,
    status: "waiting",
    createdAt: 100,
    deadline: 200,
    threadTs: reply.thread_ts,
    replies: [],
    notifications: [],
  };
  const f = fixture(t, { load: () => [old], now: () => 300 });
  await tick();
  assert.equal(f.service.get(question.id).status, "timed_out");
  assert.match(f.notices[0].text, /timed_out/);
  assert.equal(f.service.receive(reply, "UOWN123"), true);
  await tick();
  assert.equal(f.service.get(question.id).status, "received");
  assert.equal(f.service.get(question.id).error, undefined);
  assert.equal(f.posts.length, 0);
});

test("restart with an interrupted send marks delivery unknown instead of posting twice", async (t) => {
  const pending = {
    ...question,
    channel: settings.channelId,
    assistantId: settings.assistantId,
    responderId: settings.assistantId,
    status: "sending",
    createdAt: 100,
    deadline: 500,
    replies: [],
    notifications: [],
  };
  const f = fixture(t, { load: () => [pending], now: () => 300 });
  const result = await f.service.create(question);
  await tick();
  assert.equal(result.consultation.status, "delivery_unknown");
  assert.equal(f.posts.length, 0);
  assert.equal(f.notices.length, 2);
});

test("Slack rejection and uncertain send are reported, never retried under the same key", async (t) => {
  for (const uncertain of [false, true]) {
    let calls = 0;
    const f = fixture(t, {
      post: async () => {
        calls++;
        return {
          ok: false,
          error: uncertain ? "network interrupted" : "missing_scope",
          uncertain,
        };
      },
    });
    const r = await f.service.create(question);
    await tick();
    await f.service.create(question);
    assert.equal(
      r.consultation.status,
      uncertain ? "delivery_unknown" : "failed",
    );
    assert.equal(calls, 1);
    assert.equal(f.notices.length, 2);
  }
});

test("notification failures remain visible, persist and do not masquerade as delivery", async (t) => {
  const f = fixture(t, {
    notify: async () => {
      throw new Error("disconnected");
    },
  });
  await f.service.create(question);
  await tick();
  const r = f.service.get(question.id);
  assert.equal(r.status, "waiting");
  assert.equal(r.notifications[0].delivered, false);
  assert.match(r.notifications[0].error, /not confirmed/);
  assert.equal(f.saved()[0].notifications[0].delivered, false);
});

test("explicit notification recovery redelivers updates without reposting the Slack question", async (t) => {
  let offline = true;
  const delivered = [];
  const f = fixture(t, {
    notify: async (recipient) => {
      if (offline) throw new Error("offline");
      delivered.push(recipient);
    },
  });
  await f.service.create(question);
  await tick();
  assert.equal(f.service.get(question.id).notifications[0].delivered, false);
  offline = false;
  assert.equal(f.service.retryNotifications(question.id).ok, true);
  await tick();
  assert.equal(delivered.length, 2);
  assert.equal(f.posts.length, 1);
  assert.equal(f.service.get(question.id).notifications[0].delivered, true);
});

function request(
  port,
  route,
  body,
  token = "local-capability",
  method = "POST",
) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          "x-md-reply-token": token,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end(raw);
  });
}

test("real loopback broker enforces capability and preserves the existing thread-only reply guard", async (t) => {
  const f = fixture(t);
  const server = new SlackReplyServer({
    token: "local-capability",
    getBotToken: () => "test-only-token",
    consultations: f.service,
  });
  const listening = await server.start();
  t.after(() => server.stop());
  const wrong = await request(
    listening.port,
    "/consultations",
    question,
    "wrong",
  );
  assert.equal(wrong.status, 401);
  const good = await request(listening.port, "/consultations", question);
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.text).consultation.threadTs, reply.thread_ts);
  f.service.receive(reply, "UOWN123");
  await tick();
  const status = await request(
    listening.port,
    `/consultations/${question.id}`,
    undefined,
    "local-capability",
    "GET",
  );
  assert.equal(
    JSON.parse(status.text).consultation.replies[0].text,
    reply.text,
  );
  const noThread = await request(listening.port, "/reply", {
    channel: settings.channelId,
    text: "must not post",
  });
  assert.equal(noThread.status, 400);
});

test("signed Slack callback routes only pending assistant replies, independently of the normal channel filter", async (t) => {
  const f = fixture(t);
  await f.service.create(question);
  let newTasks = 0;
  const server = new SlackWebhookServer({
    port: 0,
    signingSecret: "fake-signing-secret",
    channelId: "CHUMANS123",
    onMessage: () => {
      newTasks++;
    },
    onConsultationEvent: (ev, own) => f.service.receive(ev, own),
  });
  // Bind the real HTTP handler without opening a public tunnel.
  await server.listen();
  t.after(() => server.stop());
  const port = server.server.address().port;
  const payload = JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UOWN123" }],
    event: reply,
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig =
    "v0=" +
    createHmac("sha256", "fake-signing-secret")
      .update(`v0:${ts}:${payload}`)
      .digest("hex");
  const send = (signature) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          method: "POST",
          headers: {
            "x-slack-request-timestamp": ts,
            "x-slack-signature": signature,
            "content-length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  assert.equal(await send("bad"), 403);
  assert.equal(f.service.get(question.id).status, "waiting");
  assert.equal(await send(sig), 200);
  assert.equal(await send(sig), 200);
  await tick();
  assert.equal(f.service.get(question.id).status, "received");
  assert.equal(f.service.get(question.id).replies.length, 1);
  assert.equal(newTasks, 0);
});
