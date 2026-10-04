/**
 * Subagent Client — JSON-RPC over stdio 客户端
 *
 * 管理 subagent-server 生命周期，通过 JSON-RPC 协议通信
 * 支持流式输出、并发请求、故障恢复
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { getPiInvocation, runPiProcess, terminateChild, TASK_TIMEOUT_MS, type PiInvocation, type ProcessResult } from "./subagent-process.ts";
import type { Message } from "@earendil-works/pi-ai";

// ── 类型 ──────────────────────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── 配置 ──────────────────────────────────────────────────────────

// ── Subagent Server 管理器 ──────────────────────────────────────

export interface ServerOptions {
  piInvocation?: PiInvocation;
  serverScriptPath?: string;
  serverStartTimeoutMs?: number;
  requestTimeoutMs?: number;
  taskTimeoutMs?: number;
  maxWorkers?: number;
}

export class SubagentServerManager {
  private serverProcess: ReturnType<typeof spawn> | null = null;
  private serverReady = false;
  private requestIdCounter = 0;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private pendingRequests = new Map<string | number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private messageHandlers = new Map<string, Set<(params: any) => void>>();
  private taskHandlers = new Map<string | number, (message: Message) => void>();
  private options: ServerOptions;
  private serverScriptPath: string;

  constructor(options: ServerOptions = {}) {
    this.options = options;
    this.serverScriptPath = options.serverScriptPath ?? fileURLToPath(new URL("./subagent-server.ts", import.meta.url));
    if (!options.serverScriptPath && !fs.existsSync(this.serverScriptPath)) this.serverScriptPath = this.serverScriptPath.replace(/\.ts$/, ".js");
  }

  async ensureRunning(): Promise<void> {
    if (this.shutdownPromise) throw new Error("Subagent service is shutting down");
    if (this.isRunning) return;
    const pending = this.startPromise ?? (this.startPromise = this.startServer());
    try { await pending; }
    finally { if (this.startPromise === pending) this.startPromise = null; }
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let proc: ReturnType<typeof spawn>;
      const finishStart = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error); else resolve();
      };
      const timeout = setTimeout(() => {
        finishStart(new Error("Subagent server start timed out"));
        this.dispose();
      }, this.options.serverStartTimeoutMs ?? 10_000);
      try {
        const invocation = this.options.piInvocation ?? getPiInvocation();
        proc = spawn(process.execPath, [
          this.serverScriptPath, "--pi-invocation", JSON.stringify(invocation),
          "--task-timeout-ms", String(this.options.taskTimeoutMs ?? TASK_TIMEOUT_MS),
          "--max-workers", String(this.options.maxWorkers ?? 4),
        ], { shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
        this.serverProcess = proc;
        const decoder = new StringDecoder("utf8");
        let buffer = "";
        const onLine = (line: string) => {
          let message: JsonRpcMessage;
          try { message = JSON.parse(line); } catch { return; }
          if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
          if ("id" in message && ("result" in message || "error" in message)) {
            const response = message as JsonRpcResponse;
            if (response.id === undefined) return;
            const pending = this.pendingRequests.get(response.id);
            if (!pending) return;
            this.pendingRequests.delete(response.id);
            if (response.error) pending.reject(new Error(response.error.message));
            else pending.resolve(response.result);
          } else if ("method" in message && !("id" in message)) {
            const notification = message as JsonRpcNotification;
            if (notification.method === "server_ready" && this.serverProcess === proc && !settled) {
              this.serverReady = true;
              finishStart();
            }
            if (notification.method === "message" && notification.params?.message) {
              const id = notification.params.id as string | number;
              try { this.taskHandlers.get(id)?.(notification.params.message as Message); }
              catch {
                const pending = this.pendingRequests.get(id);
                this.pendingRequests.delete(id);
                pending?.reject(new Error("Subagent progress callback failed"));
                void this.cancelTask(id);
              }
            }
            for (const handler of this.messageHandlers.get(notification.method) ?? []) {
              try { handler(notification.params); }
              catch { this.dispose(new Error("Subagent notification callback failed")); }
            }
          }
        };
        proc.stdout.on("data", (chunk: Buffer) => {
          buffer += decoder.write(chunk);
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) onLine(line);
        });
        proc.stderr.resume();
        proc.stdin.on("error", (error) => { if (this.serverProcess === proc) this.dispose(new Error(`Subagent service input failed (${(error as NodeJS.ErrnoException).code || "pipe"})`)); });
        proc.on("error", (error: NodeJS.ErrnoException) => {
          finishStart(new Error(`Failed to start subagent server (${error.code || "spawn"})`));
        });
        proc.on("close", (code) => {
          buffer += decoder.end();
          if (buffer.trim()) onLine(buffer);
          finishStart(new Error(`Subagent server exited before readiness (${code})`));
          if (this.serverProcess !== proc) return;
          this.serverProcess = null;
          this.serverReady = false;
          this.rejectPending(new Error(`Subagent server disconnected (${code})`));
        });
      } catch (error) { finishStart(error as Error); }
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  private sendRequest(method: string, params: Record<string, unknown>, id = ++this.requestIdCounter): Promise<any> {
    return new Promise((resolve, reject) => {
      const proc = this.serverProcess;
      if (!this.isRunning || !proc?.stdin.writable) { reject(new Error("Subagent service is not connected")); return; }
      const timeout = setTimeout(() => {
        // An unresponsive service has an unknown execution outcome. Stop it;
        // callers must not replay a possibly completed task automatically.
        this.dispose(new Error(`Subagent request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? TASK_TIMEOUT_MS + 10_000);
      this.pendingRequests.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (error && this.serverProcess === proc) this.dispose(new Error("Subagent service write failed"));
      });
    });
  }

  onNotification(method: string, handler: (params: any) => void): () => void {
    let handlers = this.messageHandlers.get(method);
    if (!handlers) { handlers = new Set(); this.messageHandlers.set(method, handlers); }
    handlers.add(handler);
    return () => { handlers!.delete(handler); if (!handlers!.size) this.messageHandlers.delete(method); };
  }

  async executeTask(
    agent: string, task: string, systemPrompt: string, cwd: string,
    onMessage?: (message: Message) => void,
    options: { model?: string; tools?: string[]; signal?: AbortSignal } = {},
  ): Promise<ProcessResult> {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    await this.ensureRunning();
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    const id = ++this.requestIdCounter;
    this.taskHandlers.set(id, onMessage ?? (() => {}));
    const abort = () => { void this.cancelTask(id); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.sendRequest("execute", { agent, task, systemPrompt, cwd, model: options.model, tools: options.tools }, id);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.taskHandlers.delete(id);
    }
  }

  async cancelTask(taskId: string | number): Promise<boolean> {
    if (!this.isRunning) return false;
    try { return Boolean((await this.sendRequest("cancel", { id: taskId })).cancelled); }
    catch { return false; }
  }

  async getStatus(): Promise<any> { await this.ensureRunning(); return this.sendRequest("status", {}); }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const proc = this.serverProcess;
    if (!proc) return;
    this.shutdownPromise = (async () => {
      try {
        if (this.isRunning) await this.sendRequest("shutdown", {});
        else this.dispose();
        if (proc.exitCode === null && proc.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => { this.dispose(); resolve(); }, 2000);
            proc.once("close", () => { clearTimeout(timeout); resolve(); });
          });
        }
      } finally { this.dispose(); }
    })();
    try { await this.shutdownPromise; } finally { this.shutdownPromise = null; }
  }

  /** Synchronous parent-exit path: EOF asks the existing server to clean up. */
  disconnect(): void { this.serverProcess?.stdin.end(); }

  /** Emergency stop for a failed transport; never starts a server. */
  dispose(error = new Error("Subagent service stopped")): void {
    const proc = this.serverProcess;
    this.serverProcess = null;
    this.serverReady = false;
    this.rejectPending(error);
    if (proc) terminateChild(proc);
  }

  get isRunning(): boolean { return Boolean(this.serverReady && this.serverProcess && this.serverProcess.exitCode === null && this.serverProcess.signalCode === null); }
  get pendingTaskCount(): number { return this.taskHandlers.size; }
}


// ── 全局单例 ────────────────────────────────────────────────────

let globalServerManager: SubagentServerManager | null = null;

export function getServerManager(): SubagentServerManager {
  if (!globalServerManager) {
    globalServerManager = new SubagentServerManager();
  }
  return globalServerManager;
}

export function getActiveServerManager(): SubagentServerManager | null {
  return globalServerManager;
}

export function resetServerManager(): void {
  if (globalServerManager) {
    const manager = globalServerManager;
    manager.shutdown().catch(() => { console.error("[subagent] Service cleanup failed."); manager.dispose(); });
    globalServerManager = null;
  }
}

// ── 兼容层：老式 spawn 回退 ─────────────────────────────────────

export async function runSingleAgentFallback(
  defaultCwd: string, agent: AgentConfig, task: string, cwd: string | undefined,
  step: number | undefined, signal: AbortSignal | undefined,
  onUpdate?: (result: SingleResult) => void,
  options: { invocation?: PiInvocation; timeoutMs?: number } = {},
): Promise<SingleResult> {
  const partial: SingleResult = {
    agent: agent.name, agentSource: agent.source, task, step, exitCode: -1, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, model: agent.model,
  };
  const result = await runPiProcess(options.invocation ?? getPiInvocation(), {
    task, systemPrompt: agent.systemPrompt, cwd: cwd ?? defaultCwd, model: agent.model, tools: agent.tools,
  }, signal, (_message, progress) => {
    partial.messages = progress.messages;
    partial.usage = { ...progress.usage };
    partial.model = progress.model;
    partial.stopReason = progress.stopReason;
    partial.errorMessage = progress.errorMessage;
    onUpdate?.({ ...partial });
  }, options.timeoutMs ?? TASK_TIMEOUT_MS);
  if (result.exitCode === 0 && result.messages.length === 0) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = "Subagent returned no messages; task was not replayed";
  }
  return { ...partial, ...result };
}


export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}