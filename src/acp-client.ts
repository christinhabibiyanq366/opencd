import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcError = { code: number; message: string };
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
};

type Pending = {
  resolve: (msg: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function pickPermissionOption(options: unknown): string | null {
  if (!Array.isArray(options)) return "allow_always";
  for (const desired of ["allow_always", "allow_once"]) {
    const hit = options.find(
      (o) => typeof o === "object" && o && (o as { kind?: string }).kind === desired,
    ) as { optionId?: string } | undefined;
    if (hit?.optionId) return hit.optionId;
  }
  const fallback = options.find((o) => {
    if (!o || typeof o !== "object") return false;
    const kind = (o as { kind?: string }).kind ?? "";
    return kind !== "reject_once" && kind !== "reject_always";
  }) as { optionId?: string } | undefined;
  return fallback?.optionId ?? null;
}

function extractChunkText(msg: JsonRpcMessage): string {
  const update = msg.params?.update as Record<string, unknown> | undefined;
  if (!update) return "";
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  const content = update.content as Record<string, unknown> | undefined;
  return typeof content?.text === "string" ? content.text : "";
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item));
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") return [obj.text];
  return Object.values(obj).flatMap((v) => collectText(v));
}

export class AcpClient {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private requestId = 1;
  private onNotification?: (msg: JsonRpcMessage) => Promise<void> | void;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
  ) {}

  async start(): Promise<void> {
    console.log(`[acp] spawning: ${this.command} ${this.args.join(" ")} (cwd=${this.cwd})`);
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`[acp] pid=${this.process.pid}`);

    this.process.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) console.error(`[kiro stderr] ${line}`);
      }
    });

    this.process.on("error", (err) => {
      console.error(`[acp] process error: ${err.message}`);
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
    });

    this.process.on("exit", (code, signal) => {
      console.warn(`[acp] process exited code=${code} signal=${signal}`);
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("ACP process exited"));
      }
      this.pending.clear();
    });

    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", async (line) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        console.warn(`[acp] non-JSON stdout: ${line}`);
        return;
      }
      await this.handleMessage(msg);
    });
  }

  async close(): Promise<void> {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = undefined;
  }

  async initialize(): Promise<void> {
    console.log("[acp] → initialize");
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "opencd", version: "0.1.0" },
    });
    console.log("[acp] ← initialize ok");
  }

  async createSession(cwd: string): Promise<string> {
    console.log(`[acp] → session/new cwd=${cwd}`);
    const response = await this.request("session/new", { cwd, mcpServers: [] }, 120_000);
    const sessionId = (response.result as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) throw new Error("ACP session/new did not return sessionId");
    console.log(`[acp] ← session/new sessionId=${sessionId}`);
    return sessionId;
  }

  async prompt(sessionId: string, prompt: string, onChunk?: (text: string) => void): Promise<string> {
    console.log(`[acp] → session/prompt sessionId=${sessionId} promptLen=${prompt.length}`);
    let text = "";
    let chunkCount = 0;
    this.onNotification = (msg) => {
      const chunk = extractChunkText(msg);
      if (chunk) {
        text += chunk;
        chunkCount++;
        if (chunkCount === 1) console.log("[acp] first chunk received");
        onChunk?.(text);
      }
    };
    const response = await this.request(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      },
      600_000,
    );
    this.onNotification = undefined;
    console.log(`[acp] ← session/prompt done chunks=${chunkCount} totalLen=${text.length}`);
    if (text.trim()) return text.trim();
    const fallback = collectText(response.result).join("").trim();
    return fallback || "(no response)";
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (msg.method === "session/request_permission" && typeof msg.id === "number") {
      const optionId = pickPermissionOption(msg.params?.options);
      console.log(`[acp] permission request id=${msg.id} → optionId=${optionId ?? "cancelled"}`);
      const result = optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
      await this.writeLine({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }

    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg);
      }
      return;
    }

    if (this.onNotification) {
      await this.onNotification(msg);
    }
  }

  private async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<JsonRpcMessage> {
    if (!this.process) throw new Error("ACP process not started");
    const id = this.requestId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.writeLine(payload).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      });
    });
  }

  private async writeLine(payload: Record<string, unknown>): Promise<void> {
    if (!this.process) throw new Error("ACP process not started");
    const line = `${JSON.stringify(payload)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.process!.stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

