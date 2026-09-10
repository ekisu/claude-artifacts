import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocketServer } from "ws";

import { artifactId, createArtifactClient } from "../src/api.js";
import { ArtifactFeedbackWatch } from "../src/feedback.js";
import { createOpenCodePlugin } from "../src/opencode.js";
import { createOpenCodePlugin as bundledPlugin } from "../dist/opencode/index.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const t1 = "2026-09-10T18:15:00Z";
const t2 = "2026-09-10T18:16:00Z";
const t3 = "2026-09-10T18:17:00Z";
const thread = () => ({ id: "thread-1", anchor: { label: "Revenue chart", path: "main > section" }, comments: [{ id: "comment-1", author: { account: "reviewer", access: "owner" }, text: "Make the chart clearer", created_at: t1 }] });

async function until(check, message = "condition was not met") {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error(message);
}

async function fixture(t) {
  const state = { threads: [thread()], reads: 0, boots: 0, connections: 0, frames: [], requests: [], ttl: 3600 };
  const server = http.createServer((request, response) => {
    state.requests.push({ url: request.url, headers: request.headers });
    response.setHeader("content-type", "application/json");
    if (request.url === `/api/frame/${id}?via=model_read`) {
      state.boots++;
      response.end(JSON.stringify({ ver: "version-1", subscriptionToken: `token-${state.boots}`, subscriptionTokenExp: Math.ceil(Date.now() / 1000) + state.ttl }));
    } else if (request.url === `/api/frame/comments/${id}`) {
      state.reads++;
      if (state.readFailure) {
        response.statusCode = state.readFailure;
        response.end(JSON.stringify({ error: "temporarily unavailable" }));
      } else response.end(JSON.stringify(state.malformed ? {} : { threads: state.threads }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "wrong endpoint" }));
    }
  });
  const sockets = new WebSocketServer({ server, handleProtocols: (protocols) => {
    assert.equal([...protocols][0], "frame-live.v1");
    assert.match([...protocols][1], /^token-\d+$/);
    return "frame-live.v1";
  } });
  sockets.on("connection", (socket, request) => {
    assert.equal(request.url, `/edge-api/frame-live/${id}/ws`);
    state.connections++;
    socket.on("message", (message) => {
      state.frames.push(String(message));
      if (String(message) === "ping") socket.send("pong");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  state.client = createArtifactClient({ baseUrl: origin, liveOrigin: origin, token: async () => "fake-oauth" });
  state.emit = (event = { kind: "comment" }) => { for (const socket of sockets.clients) socket.send(JSON.stringify(event)); };
  state.disconnect = () => { for (const socket of sockets.clients) socket.terminate(); };
  t.after(async () => {
    state.disconnect();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return state;
}

test("live comment signals deliver only sent feedback; duplicates, resends, activation, resolution, and idle reads", async (t) => {
  const state = await fixture(t);
  const events = [];
  const watch = new ArtifactFeedbackWatch({ artifact: id, client: state.client, onFeedback: async (event) => events.push(event), heartbeatMs: 25 });
  t.after(() => watch.stop());
  await watch.start();
  await until(() => state.frames.includes("hb"));
  const baselineReads = state.reads;
  await delay(100);
  assert.equal(state.reads, baselineReads, "heartbeats must not poll comments");
  assert.ok(state.frames.filter((frame) => frame === "ping").length > 1);
  state.emit();
  await until(() => state.reads > baselineReads);
  assert.equal(events.length, 0, "ordinary unsent comment is not a submission");

  state.threads[0].comments[0].to_claude_at = t1;
  state.emit();
  await until(() => events.length === 1);
  assert.equal(events[0].thread.anchor.label, "Revenue chart");
  assert.equal(events[0].submissions[0].comment_id, "comment-1");
  const reads = state.reads;
  for (let i = 0; i < 20; i++) state.emit();
  await until(() => state.reads > reads);
  await delay(30);
  assert.equal(events.length, 1);

  state.threads[0].comments[0].to_claude_at = t2;
  state.emit();
  await until(() => events.length === 2);
  assert.notEqual(events[0].event_id, events[1].event_id, "resending is a new event");
  state.threads[0].claude_activated_at = t2;
  state.emit();
  await until(() => events.length === 3);
  assert.equal(events[2].submissions[0].kind, "activation");

  state.threads[0].resolved_at = t3;
  state.threads[0].comments[0].to_claude_at = t3;
  state.threads[0].comments.push({ id: "agent-reply", text: "Done", author: { role: "assistant" }, to_claude_at: t3 });
  const before = state.reads;
  state.emit();
  await until(() => state.reads > before);
  await delay(30);
  assert.equal(events.length, 3, "resolved threads and assistant replies must not trigger work");
  assert.ok(state.requests.every((request) => request.headers.authorization === "Bearer fake-oauth" && !request.headers.cookie));
});

test("reconnect renews tokens and catches up without replaying old submissions", async (t) => {
  const state = await fixture(t);
  state.threads[0].comments[0].to_claude_at = t1;
  const events = [];
  const watch = new ArtifactFeedbackWatch({ artifact: id, client: state.client, onFeedback: async (event) => events.push(event), retryMs: 20 });
  t.after(() => watch.stop());
  await watch.start();
  assert.equal(events.length, 0, "default start baselines old submissions");
  state.disconnect();
  state.threads[0].comments[0].to_claude_at = t2;
  await until(() => state.connections === 2 && events.length === 1);
  assert.equal(state.boots, 2);
  state.disconnect();
  await until(() => state.connections === 3);
  await delay(50);
  assert.equal(events.length, 1);
  watch.stop();
  state.emit();
  const boots = state.boots;
  await delay(80);
  assert.equal(state.boots, boots, "stop must cancel reconnects");
});

test("refreshes an expiring token while the socket is healthy", async (t) => {
  const state = await fixture(t);
  state.ttl = 1;
  const watch = new ArtifactFeedbackWatch({ artifact: id, client: state.client, onFeedback: async () => {}, retryMs: 10, refreshLeadMs: 60000 });
  t.after(() => watch.stop());
  await watch.start();
  await until(() => state.connections >= 2, "expiring token was not renewed");
  assert.ok(state.boots >= 2);
});

test("failed delivery retries the exact event before processing a later submission", async (t) => {
  const state = await fixture(t);
  const attempts = [];
  let fail = true;
  const watch = new ArtifactFeedbackWatch({ artifact: id, client: state.client, retryMs: 60, onFeedback: async (event) => {
    attempts.push(JSON.stringify(event));
    if (fail) { fail = false; throw new Error("delivery failed after possible admission"); }
  } });
  t.after(() => watch.stop());
  await watch.start();
  state.threads[0].comments[0].to_claude_at = t1;
  state.emit();
  await until(() => attempts.length === 1);
  state.threads[0].comments.push({ id: "comment-2", author: { account: "reviewer" }, text: "Also label the axis", to_claude_at: t2 });
  await until(() => attempts.length === 3);
  assert.equal(attempts[0], attempts[1], "retry must preserve the complete event payload");
  assert.notEqual(attempts[1], attempts[2]);
  assert.equal(watch.status().delivered, 2);
});

test("reports malformed reads and stops after repeated failures", async (t) => {
  const state = await fixture(t);
  const watch = new ArtifactFeedbackWatch({ artifact: id, client: state.client, retryMs: 10, maxFailures: 3, onFeedback: async () => assert.fail("unexpected feedback") });
  t.after(() => watch.stop());
  await watch.start();
  state.malformed = true;
  state.emit();
  await until(() => watch.status().state === "failed");
  assert.match(watch.status().error, /invalid thread response/);
});

function pluginContext() {
  const tools = new Map();
  const hooks = [];
  const admissions = [];
  return {
    tools, hooks, admissions,
    ctx: {
      options: {},
      tool: {
        transform: async (callback) => {
          callback({ add(tool) { tools.set(tool.name.replace("artifact_feedback_", ""), tool); } });
          return { dispose() { tools.clear(); } };
        },
        hook: async (name, callback) => {
          assert.equal(name, "execute.after");
          hooks.push(callback);
          return { dispose() { hooks.splice(hooks.indexOf(callback), 1); } };
        },
      },
      session: { synthetic: async (input) => { admissions.push(input); return { id: input.id }; } },
    },
    async call(name, input = {}, sessionID = "ses_first") {
      const tool = tools.get(name);
      const result = await tool.execute(input, { sessionID });
      if (result.output !== undefined) assert.equal(tool.output?.type, "object", "structured output requires a registered output schema");
      return result;
    },
  };
}

for (const [name, factory] of [["source", createOpenCodePlugin], ["bundle", bundledPlugin]]) {
  test(`${name} plugin routes feedback to the owning session and cleans up`, async (t) => {
    const state = await fixture(t);
    const context = pluginContext();
    const cleanup = await factory({ client: state.client, watchOptions: { retryMs: 10 } }).setup(context.ctx);
    t.after(cleanup);
    await Promise.all([context.call("watch", { artifact: id }), context.call("watch", { artifact: id })]);
    assert.equal(state.connections, 1, "concurrent watches should share the session subscription");
    assert.equal((await context.call("status", {}, "ses_other")).output.watches.length, 0);
    state.threads[0].comments[0].to_claude_at = t1;
    state.emit();
    await until(() => context.admissions.length === 1);
    const admission = context.admissions[0];
    assert.equal(admission.sessionID, "ses_first");
    assert.equal(admission.delivery, "queue");
    assert.equal(admission.resume, true);
    assert.match(admission.id, /^msg_[a-f0-9]{32}$/);
    assert.equal(admission.metadata.source, "claude-artifacts.feedback");
    assert.match(admission.text, /Make the chart clearer/);
    assert.match(admission.text, /external content/);

    await context.call("unwatch", { artifact: id }, "ses_other");
    assert.equal((await context.call("status")).output.watches.length, 1);
    await context.call("unwatch", { artifact: id });
    assert.equal((await context.call("status")).output.watches.length, 0);
    await context.hooks[0]({ status: "completed", sessionID: "ses_first", tool: "claude_artifacts_claude_artifacts__update", result: { content: JSON.stringify({ artifact_url: `https://claude.ai/code/artifact/${id}` }) } });
    assert.equal(state.connections, 1, "publishing must respect explicit unwatch");
    await cleanup();
    assert.equal(context.tools.size, 0);
  });
}

test("successful publish auto-watches; include_existing opts into old feedback", async (t) => {
  const state = await fixture(t);
  state.threads[0].comments[0].to_claude_at = t1;
  const context = pluginContext();
  const cleanup = await createOpenCodePlugin({ client: state.client }).setup(context.ctx);
  t.after(cleanup);
  await context.hooks[0]({ status: "completed", sessionID: "ses_first", tool: "claude_artifacts_claude_artifacts__create", result: { content: [{ type: "text", text: JSON.stringify({ artifact_url: `https://claude.ai/code/artifact/${id}` }) }] } });
  assert.equal((await context.call("status")).output.watches[0].state, "connected");
  assert.equal(context.admissions.length, 0);
  await context.call("unwatch");
  await context.call("watch", { artifact: id, include_existing: true });
  assert.equal(context.admissions.length, 1);
});

test("rejects unrelated URLs rather than treating a path as an artifact", () => {
  assert.equal(artifactId(`https://claude.ai/code/artifact/${id}/?foo=bar`), id);
  assert.throws(() => artifactId(`https://example.com/code/artifact/${id}`), /claude.ai/);
  assert.throws(() => artifactId("../../other-api"), /URL or UUID/);
});
