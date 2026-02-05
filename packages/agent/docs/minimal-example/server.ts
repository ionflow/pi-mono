// server.ts - Production HTTP server for the agent
// Compatible with both Node.js (via tsx) and Bun
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Define bash tool schema using TypeBox
const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

// Implement the bash tool
const bashTool: AgentTool<typeof bashSchema, { exitCode: number | null }> = {
  name: "bash",
  label: "Bash",
  description: "Execute a bash command and return stdout/stderr",
  parameters: bashSchema,
  execute: async (toolCallId, args, signal, onUpdate) => {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", args.command], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";

      child.stdout?.on("data", (data) => {
        output += data.toString();
        onUpdate?.({
          content: [{ type: "text", text: output }],
          details: { exitCode: null },
        });
      });

      child.stderr?.on("data", (data) => {
        output += data.toString();
      });

      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("Command aborted"));
          return;
        }

        if (code !== 0) {
          reject(new Error(`${output}\n\nExit code: ${code}`));
          return;
        }

        resolve({
          content: [{ type: "text", text: output || "(no output)" }],
          details: { exitCode: code },
        });
      });
    });
  },
};

// CORS headers for browser compatibility
function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Parse JSON body from request
async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Send JSON response
function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Send SSE event
function sendSSE(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Handle prompt requests with SSE streaming
async function handlePrompt(req: IncomingMessage, res: ServerResponse) {
  const body = (await parseBody(req)) as { message?: string };

  if (!body.message || typeof body.message !== "string") {
    sendJson(res, 400, { error: "Missing or invalid 'message' field" });
    return;
  }

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Create a fresh agent for each request
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant. Use the bash tool to help users.",
      model: getModel("anthropic", "claude-sonnet-4-20250514"),
      tools: [bashTool],
    },
  });

  // Subscribe to agent events and stream them via SSE
  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          sendSSE(res, "text", { delta: event.assistantMessageEvent.delta });
        }
        break;
      case "tool_execution_start":
        sendSSE(res, "tool_start", { tool: event.toolName, args: event.args });
        break;
      case "tool_execution_end":
        sendSSE(res, "tool_end", {
          tool: event.toolName,
          isError: event.isError,
        });
        break;
      case "agent_end":
        sendSSE(res, "done", { messages: event.messages });
        res.end();
        break;
    }
  });

  try {
    await agent.prompt(body.message);
  } catch (error) {
    sendSSE(res, "error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    res.end();
  }
}

// Request handler
async function handler(req: IncomingMessage, res: ServerResponse) {
  setCorsHeaders(res);

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  try {
    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // Prompt endpoint
    if (req.method === "POST" && url.pathname === "/prompt") {
      await handlePrompt(req, res);
      return;
    }

    // 404 for unknown routes
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Request error:", error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

// Create and start server
const server = createServer(handler);

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health  - Health check`);
  console.log(`  POST /prompt  - Send a prompt (SSE streaming response)`);
  console.log(`\nExample:`);
  console.log(
    `  curl -X POST http://localhost:${PORT}/prompt -H "Content-Type: application/json" -d '{"message": "List files"}'`
  );
});
