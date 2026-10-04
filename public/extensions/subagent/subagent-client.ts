/**
 * Subagent Client — JSON-RPC over stdio 客户端
 *
 * 管理 subagent-server 生命周期，通过 JSON-RPC 协议通信
 * 支持流式输出、并发请求、故障恢复
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
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

const CONFIG = {
  serverStartTimeoutMs: 10_000,   // 服务器启动超时
  requestTimeoutMs: 10 * 60 * 1000,  // 请求超时
  reconnectDelayMs: 1000,         // 重连延迟
  maxReconnectAttempts: 3,        // 最大重连次数
};

// ── Subagent Server 管理器 ──────────────────────────────────────

export class SubagentServerManager {
  private serverProcess: ReturnType<typeof spawn> | null = null;
  private serverReady: boolean = false;
  private requestIdCounter = 0;
  private pendingRequests = new Map<string | number, {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
  }>();
  private messageHandlers = new Map<string, (params: any) => void>();
  private stdoutBuffer = "";
  private rl: readline.Interface | null = null;
  private serverScriptPath: string;
  private startPromise: Promise<void> | null = null;

  constructor() {
    // 找到 subagent-server.ts 的路径
    this.serverScriptPath = path.resolve(__dirname, "subagent-server.ts");
    // 如果 .ts 不存在，尝试 .js
    if (!fs.existsSync(this.serverScriptPath)) {
      const jsPath = this.serverScriptPath.replace(/\.ts$/, ".js");
      if (fs.existsSync(jsPath)) {
        this.serverScriptPath = jsPath;
      }
    }
  }

  /**
   * 确保服务器正在运行
   */
  async ensureRunning(): Promise<void> {
    if (this.serverReady && this.serverProcess && !this.serverProcess.killed) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startServer();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Subagent server start timed out"));
      }, CONFIG.serverStartTimeoutMs);

      try {
        const isWindows = process.platform === "win32";
        const serverFile = this.serverScriptPath;

        // 用 tsx 或 node 运行服务器
        let command: string;
        let args: string[];

        if (serverFile.endsWith(".ts")) {
          // 尝试用 tsx 运行
          command = "npx";
          args = ["tsx", serverFile];
        } else {
          command = process.execPath;
          args = [serverFile];
        }

        const proc = spawn(command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });

        this.serverProcess = proc;

        // 解析 stdout (JSON-RPC 消息)
        let buffer = "";
        const onLine = (line: string) => {
          if (!line.trim()) return;
          let msg: JsonRpcMessage;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }

          // 处理响应
          if ("id" in msg && ("result" in msg || "error" in msg)) {
            const resp = msg as JsonRpcResponse;
            const id = resp.id;
            if (id !== undefined) {
              const pending = this.pendingRequests.get(id);
              if (pending) {
                this.pendingRequests.delete(id);
                if (resp.error) {
                  pending.reject(new Error(resp.error.message));
                } else {
                  pending.resolve(resp.result);
                }
              }
            }
          }

          // 处理通知
          if ("method" in msg && !("id" in msg)) {
            const notif = msg as JsonRpcNotification;
            const handler = this.messageHandlers.get(notif.method);
            if (handler) {
              handler(notif.params);
            }

            // server_ready 通知
            if (notif.method === "server_ready") {
              clearTimeout(timeout);
              this.serverReady = true;
              resolve();
            }
          }
        };

        proc.stdout.on("data", (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) onLine(line);
        });

        proc.stderr.on("data", (data: Buffer) => {
          // stderr 是日志，忽略或调试用
        });

        proc.on("close", (code) => {
          this.serverReady = false;
          this.serverProcess = null;

          // 拒绝所有待处理的请求
          for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error(`Server disconnected (exit code: ${code})`));
          }
          this.pendingRequests.clear();
        });

        proc.on("error", (err) => {
          clearTimeout(timeout);
          this.serverReady = false;
          this.serverProcess = null;
          reject(new Error(`Failed to start subagent server: ${err.message}`));
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * 发送 JSON-RPC 请求
   */
  private async sendRequest(method: string, params: Record<string, unknown>): Promise<any> {
    await this.ensureRunning();

    const id = ++this.requestIdCounter;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, CONFIG.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      if (this.serverProcess && !this.serverProcess.killed && this.serverProcess.stdin) {
        this.serverProcess.stdin.write(JSON.stringify(request) + "\n");
      } else {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(new Error("Server not connected"));
      }
    });
  }

  /**
   * 注册通知处理器
   */
  onNotification(method: string, handler: (params: any) => void): void {
    this.messageHandlers.set(method, handler);
  }

  /**
   * 执行任务
   */
  async executeTask(
    agent: string,
    task: string,
    systemPrompt: string,
    cwd: string,
    onMessage?: (msg: Message) => void,
  ): Promise<{
    messages: Message[];
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    stderr: string;
    exitCode: number;
    aborted?: boolean;
  }> {
    // 注册消息流通知
    const messageHandler = (params: any) => {
      if (params && params.id === agent && params.message && onMessage) {
        onMessage(params.message as Message);
      }
    };

    this.onNotification("message", messageHandler);

    try {
      const result = await this.sendRequest("execute", {
        agent,
        task,
        systemPrompt,
        cwd,
      });

      return result as any;
    } finally {
      this.messageHandlers.delete("message");
    }
  }

  /**
   * 取消任务
   */
  async cancelTask(taskId: string): Promise<boolean> {
    try {
      await this.sendRequest("cancel", { id: taskId });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取服务器状态
   */
  async getStatus(): Promise<any> {
    return this.sendRequest("status", {});
  }

  /**
   * 关闭服务器
   */
  async shutdown(): Promise<void> {
    try {
      await this.sendRequest("shutdown", {});
    } catch {
      // 忽略关闭时的错误
    }

    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill("SIGTERM");
    }

    this.serverReady = false;
    this.serverProcess = null;
  }

  get isRunning(): boolean {
    return this.serverReady && this.serverProcess !== null && !this.serverProcess.killed;
  }
}

// ── 全局单例 ────────────────────────────────────────────────────

let globalServerManager: SubagentServerManager | null = null;

export function getServerManager(): SubagentServerManager {
  if (!globalServerManager) {
    globalServerManager = new SubagentServerManager();
  }
  return globalServerManager;
}

export function resetServerManager(): void {
  if (globalServerManager) {
    globalServerManager.shutdown().catch(() => {});
    globalServerManager = null;
  }
}

// ── 兼容层：老式 spawn 回退 ─────────────────────────────────────

import { spawn as nodeSpawn } from "node:child_process";
import * as os from "node:os";

export async function runSingleAgentFallback(
  defaultCwd: string,
  agent: AgentConfig,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate?: (result: SingleResult) => void,
): Promise<SingleResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-"));
      tmpPromptDir = tmpDir;
      tmpPromptPath = path.join(tmpDir, "prompt.md");
      fs.writeFileSync(tmpPromptPath, agent.systemPrompt, "utf-8");
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);

    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const currentScript = process.argv[1];
      const isWindows = process.platform === "win32";
      let command: string;
      let spawnArgs: string[];

      if (currentScript && fs.existsSync(currentScript)) {
        command = process.execPath;
        spawnArgs = [currentScript, ...args];
      } else {
        command = "pi";
        spawnArgs = args;
      }

      const proc = nodeSpawn(
        isWindows ? "node" : command,
        isWindows ? [process.argv[1] || command, ...args] : spawnArgs,
        {
          cwd: cwd ?? defaultCwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const timeout = setTimeout(() => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 2000);
      }, 5 * 60 * 1000);

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = (msg as any).usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && (msg as any).model) currentResult.model = (msg as any).model;
            if ((msg as any).stopReason) currentResult.stopReason = (msg as any).stopReason;
            if ((msg as any).errorMessage) currentResult.errorMessage = (msg as any).errorMessage;
          }
          if (onUpdate) onUpdate({ ...currentResult });
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        clearTimeout(timeout);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        clearTimeout(timeout);
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPromptPath) {
      try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
    }
    if (tmpPromptDir) {
      try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
    }
  }
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