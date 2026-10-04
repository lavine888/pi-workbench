import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SubagentServerManager, runSingleAgentFallback } from "../public/extensions/subagent/subagent-client.ts";
import { terminateChild } from "../public/extensions/subagent/subagent-process.ts";

const fixture = fileURLToPath(new URL("./fixtures/child-cli.mjs", import.meta.url));
const server = fileURLToPath(new URL("../public/extensions/subagent/subagent-server.ts", import.meta.url));
const invocation = { command: process.execPath, args: [fixture] };
const options = { piInvocation: invocation, serverStartTimeoutMs: 2000, requestTimeoutMs: 4000, taskTimeoutMs: 2000 };
const agent = { name: "scout", description: "synthetic role", systemPrompt: "synthetic-role", tools: ["read", "grep"], model: "local/synthetic", source: "project", filePath: "synthetic/scout.md" };

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-subagent-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith("pi-workbench-subagent-test-"));
    fs.rmSync(resolved, { recursive: true });
  });
  return directory;
}

function manager(t, overrides = {}) {
  const instance = new SubagentServerManager({ ...options, ...overrides });
  t.after(() => instance.shutdown());
  return instance;
}

function output(result) {
  return JSON.parse(result.messages.find((message) => message.role === "assistant").content[0].text);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("service starts without npx and answers a status request", { timeout: 5000 }, async (t) => {
  const instance = manager(t);
  const status = await instance.getStatus();
  assert.equal(instance.isRunning, true);
  assert.equal(status.workers.max, 4);
  await instance.shutdown();
  await waitFor(() => !alive(status.server.pid));
});

test("shutdown before first use does not start a service", async () => {
  const instance = new SubagentServerManager({ ...options, serverScriptPath: "missing-synthetic-server.ts" });
  await instance.shutdown();
  assert.equal(instance.isRunning, false);
});

test("single task forwards role configuration and preserves split UTF-8", { timeout: 5000 }, async (t) => {
  const cwd = scratch(t);
  const result = await manager(t).executeTask("scout", "echo", "synthetic-role", cwd, undefined, { model: "local/synthetic", tools: ["read", "grep"] });
  assert.equal(result.exitCode, 0);
  const data = output(result);
  assert.equal(data.cwd, cwd);
  assert.equal(data.prompt, "synthetic-role");
  assert.equal(data.unicode, "状态");
  assert(data.args.includes("--no-extensions"));
  assert.equal(data.args[data.args.indexOf("--model") + 1], "local/synthetic");
  assert.equal(data.args[data.args.indexOf("--tools") + 1], "read,grep");
  assert.equal(fs.existsSync(data.promptPath), false);
});

test("parallel calls using the same role receive their own progress", { timeout: 5000 }, async (t) => {
  const instance = manager(t);
  const cwd = scratch(t);
  const received = [[], []];
  const results = await Promise.all(["first", "second"].map((task, index) => instance.executeTask("scout", task, "", cwd, (message) => received[index].push(JSON.parse(message.content[0].text).task))));
  assert.deepEqual(results.map((result) => output(result).task), ["first", "second"]);
  assert.deepEqual(received, [["first"], ["second"]]);
});

test("more tasks than slots complete and leave the queue empty", { timeout: 6000 }, async (t) => {
  const instance = manager(t, { maxWorkers: 2 });
  const cwd = scratch(t);
  const results = await Promise.all(Array.from({ length: 7 }, (_, index) => instance.executeTask("scout", "task-" + index, "", cwd)));
  assert(results.every((result) => result.exitCode === 0));
  const status = await instance.getStatus();
  assert.equal(status.workers.total, 2);
  assert.equal(status.workers.active, 0);
  assert.deepEqual(status.tasks, { running: 0, pending: 0 });
});

test("active cancellation terminates the child and cleans the prompt", { timeout: 5000 }, async (t) => {
  const instance = manager(t);
  const controller = new AbortController();
  let data;
  const result = await instance.executeTask("scout", "hang", "synthetic-role", scratch(t), (message) => {
    data = JSON.parse(message.content[0].text);
    controller.abort();
  }, { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, 130);
  await waitFor(() => !alive(data.pid));
  assert.equal(fs.existsSync(data.promptPath), false);
});

test("queued cancellation never starts the queued child", { timeout: 5000 }, async (t) => {
  const instance = manager(t, { maxWorkers: 1 });
  const cwd = scratch(t);
  const activeController = new AbortController();
  let running = false;
  const active = instance.executeTask("scout", "hang", "", cwd, () => { running = true; }, { signal: activeController.signal });
  await waitFor(() => running);
  const queuedController = new AbortController();
  let queuedStarted = false;
  const queued = instance.executeTask("scout", "queued", "", cwd, () => { queuedStarted = true; }, { signal: queuedController.signal });
  await waitFor(() => instance.pendingTaskCount === 2);
  queuedController.abort();
  const cancelled = await queued;
  assert.equal(cancelled.exitCode, 130);
  assert.equal(cancelled.messages.length, 0);
  assert.equal(queuedStarted, false);
  activeController.abort();
  await active;
});

test("pre-aborted task does not start the service", async () => {
  const instance = new SubagentServerManager({ ...options, serverScriptPath: "missing-synthetic-server.ts" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(instance.executeTask("scout", "echo", "", process.cwd(), undefined, { signal: controller.signal }), /abort/i);
  assert.equal(instance.isRunning, false);
});

test("task timeout stays a failure and cleans temporary files", { timeout: 5000 }, async (t) => {
  const instance = manager(t, { taskTimeoutMs: 500 });
  let data;
  const result = await instance.executeTask("scout", "hang", "synthetic-role", scratch(t), (message) => { data = JSON.parse(message.content[0].text); });
  assert.equal(result.exitCode, 124);
  assert.equal(result.aborted, true);
  assert.match(result.errorMessage, /timed out/i);
  assert(data);
  assert.equal(fs.existsSync(data.promptPath), false);
  await waitFor(() => !alive(data.pid));
});

test("child failure returns its exit code and frees the slot", { timeout: 5000 }, async (t) => {
  const instance = manager(t, { maxWorkers: 1 });
  const cwd = scratch(t);
  assert.equal((await instance.executeTask("scout", "crash", "", cwd)).exitCode, 7);
  assert.equal((await instance.executeTask("scout", "echo", "", cwd)).exitCode, 0);
});

test("spawn failure is reported and later requests still complete", { timeout: 5000 }, async (t) => {
  const cwd = scratch(t);
  const instance = manager(t);
  const failed = await instance.executeTask("scout", "echo", "synthetic-role", path.join(cwd, "missing"));
  assert.equal(failed.exitCode, 1);
  assert.match(failed.errorMessage, /launch/i);
  assert.equal((await instance.executeTask("scout", "echo", "", cwd)).exitCode, 0);
});

test("shutdown cancels active and queued tasks and terminates descendants", { timeout: 6000 }, async (t) => {
  const instance = manager(t, { maxWorkers: 1 });
  const cwd = scratch(t);
  let data;
  const active = instance.executeTask("scout", "spawn-child", "synthetic-role", cwd, (message) => { data = JSON.parse(message.content[0].text); });
  await waitFor(() => Boolean(data));
  const queued = instance.executeTask("scout", "queued", "", cwd);
  await waitFor(() => instance.pendingTaskCount === 2);
  await instance.shutdown();
  const results = await Promise.all([active, queued]);
  assert(results.every((result) => result.aborted));
  await waitFor(() => !alive(data.pid) && !alive(data.childPid));
  assert.equal(fs.existsSync(data.promptPath), false);
  assert.equal(instance.pendingTaskCount, 0);
});

test("direct fallback uses the same arguments and cleanup behavior", { timeout: 5000 }, async (t) => {
  const cwd = scratch(t);
  const result = await runSingleAgentFallback(cwd, agent, "echo", undefined, 2, undefined, undefined, { invocation });
  assert.equal(result.exitCode, 0);
  assert.equal(result.step, 2);
  const data = output(result);
  assert.equal(data.prompt, "synthetic-role");
  assert.equal(data.args[data.args.indexOf("--tools") + 1], "read,grep");
  assert.equal(fs.existsSync(data.promptPath), false);
  const empty = await runSingleAgentFallback(cwd, agent, "silent", undefined, undefined, undefined, undefined, { invocation });
  assert.equal(empty.exitCode, 1);
  assert.equal(empty.stopReason, "error");
  assert.equal(fs.readFileSync(path.join(cwd, "synthetic-starts.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("explicit empty tool list disables tools", { timeout: 5000 }, async (t) => {
  const result = await manager(t).executeTask("scout", "echo", "", scratch(t), undefined, { tools: [] });
  assert(output(result).args.includes("--no-tools"));
});

test("JSON-RPC numeric and string IDs retain their types", { timeout: 5000 }, async (t) => {
  const cwd = scratch(t);
  const child = spawn(process.execPath, [server, "--pi-invocation", JSON.stringify(invocation)], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) terminateChild(child); });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  await waitFor(() => messages.some((message) => message.method === "server_ready"));
  for (const id of [7, "7"]) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "execute", params: { task: "echo", cwd } }) + "\n");
  await waitFor(() => messages.filter((message) => "result" in message).length === 2);
  assert.deepEqual(new Set(messages.filter((message) => "result" in message).map((message) => message.id)), new Set([7, "7"]));
  child.stdin.end();
  await closed;
});

test("startup timeout rejects and terminates the unready service", { timeout: 5000 }, async (t) => {
  const instance = manager(t, { serverScriptPath: fileURLToPath(new URL("./fixtures/never-ready-server.mjs", import.meta.url)), serverStartTimeoutMs: 500 });
  let pid;
  instance.onNotification("booting", (params) => { pid = params.pid; });
  await assert.rejects(instance.getStatus(), /start timed out/);
  assert(pid);
  await waitFor(() => !alive(pid));
  assert.equal(instance.isRunning, false);
});

test("request timeout rejects and terminates the unresponsive service", { timeout: 5000 }, async (t) => {
  const instance = manager(t, { serverScriptPath: fileURLToPath(new URL("./fixtures/unresponsive-server.mjs", import.meta.url)), requestTimeoutMs: 300 });
  let pid;
  instance.onNotification("server_ready", (params) => { pid = params.pid; });
  await assert.rejects(instance.getStatus(), /request timed out/);
  await waitFor(() => !alive(pid));
  assert.equal(instance.pendingTaskCount, 0);
});

test("stdin closure cancels work and allows the server to exit", { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, [server, "--pi-invocation", JSON.stringify(invocation)], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) terminateChild(child); });
  const cwd = scratch(t);
  child.stderr.resume();
  let data;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    if (event.method === "message") data = JSON.parse(event.params.message.content[0].text);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "execute", params: { task: "hang", systemPrompt: "synthetic-role", cwd } }) + "\n");
  await waitFor(() => Boolean(data));
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0);
  await waitFor(() => !alive(data.pid));
  assert.equal(fs.existsSync(data.promptPath), false);
});

test("fallback cancellation stops work without another launch", { timeout: 5000 }, async (t) => {
  const cwd = scratch(t);
  const controller = new AbortController();
  let data;
  const result = await runSingleAgentFallback(cwd, agent, "hang", undefined, undefined, controller.signal, (partial) => {
    data = output(partial);
    controller.abort();
  }, { invocation });
  assert.equal(result.exitCode, 130);
  await waitFor(() => !alive(data.pid));
  assert.equal(fs.existsSync(data.promptPath), false);
  assert.equal(fs.readFileSync(path.join(cwd, "synthetic-starts.jsonl"), "utf8").trim().split("\n").length, 1);
});
