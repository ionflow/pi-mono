# Building AI Agents with pi-agent-core

This guide shows how to build AI agents using `@mariozechner/pi-agent-core`. We'll create a working CLI agent with a bash tool, then explore production patterns from pi-coding-agent.

For API details, see the [README](../README.md).

> **Working Example**: Complete working examples are available at [`docs/minimal-example/`](./minimal-example/):
> - `minimal-agent.ts` - High-level Agent class (recommended)
> - `low-level-agent.ts` - Low-level agentLoop for custom state management
> - `server.ts` - HTTP server with SSE streaming

## Quick Start (Monorepo)

If you're working within the pi-mono repository:

```bash
# 1. Build the packages first (required)
npm run build

# 2. Go to the minimal example
cd packages/agent/docs/minimal-example

# 3. Copy and configure your API key
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# 4. Run the high-level CLI agent (recommended)
npx tsx minimal-agent.ts "List files in this directory"

# 5. Or run the low-level CLI agent (for custom state management)
npx tsx low-level-agent.ts "List files in this directory"

# 6. Or run the HTTP server
npx tsx server.ts
# Then test: curl -X POST http://localhost:3000/prompt -H "Content-Type: application/json" -d '{"message": "Hello"}'
```

---

## Complete Minimal Example

Here's a fully runnable agent with a bash tool:

```typescript
// minimal-agent.ts
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// 1. Define bash tool schema using TypeBox
const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

// 2. Implement the bash tool
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

      // Stream stdout
      child.stdout?.on("data", (data) => {
        output += data.toString();
        // Stream partial results to UI
        onUpdate?.({
          content: [{ type: "text", text: output }],
          details: { exitCode: null },
        });
      });

      // Capture stderr
      child.stderr?.on("data", (data) => {
        output += data.toString();
      });

      // Handle abort signal
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("Command aborted"));
          return;
        }

        // Throw on non-zero exit - agent reports this as tool error
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

// 3. Create the agent
const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful CLI assistant. Use the bash tool to help users.",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    tools: [bashTool],
  },
});

// 4. Subscribe to events for CLI output
agent.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      // Stream assistant text as it arrives
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`\n[Running: ${event.toolName}]`);
      break;
    case "tool_execution_end":
      if (event.isError) {
        console.log(`[Error]`);
      }
      break;
  }
});

// 5. Run the agent
async function main() {
  const prompt = process.argv[2] || "List the files in the current directory";
  console.log(`> ${prompt}\n`);

  await agent.prompt(prompt);

  console.log("\n");
}

main().catch(console.error);
```

**To run this example:**

```bash
# Install dependencies
npm install @mariozechner/pi-agent-core @mariozechner/pi-ai @sinclair/typebox dotenv

# Set your API key (choose one method)
# Option 1: Environment variable
export ANTHROPIC_API_KEY=your-key-here

# Option 2: Create a .env file (requires adding `import "dotenv/config"` at the top of your file)
echo "ANTHROPIC_API_KEY=your-key-here" > .env

# Run with tsx or ts-node
npx tsx minimal-agent.ts "What files are in this directory?"
```

> **Note for monorepo users**: If you're working in the pi-mono repository, the packages must be built first with `npm run build` at the repository root. See the [Quick Start](#quick-start-monorepo) section above.

---

## High-Level vs Low-Level API

pi-agent-core provides two ways to build agents:

| Feature | `Agent` class (high-level) | `agentLoop` (low-level) |
|---------|---------------------------|------------------------|
| State management | Automatic | Manual |
| Event subscription | `agent.subscribe()` | `for await` loop |
| Abort/control | `agent.abort()`, `agent.steer()` | AbortSignal |
| Context updates | Automatic | Manual (capture from `agent_end`) |
| Learning curve | Easier | More complex |
| Flexibility | Opinionated | Full control |

### When to use the `Agent` class (recommended for most cases)

- Building CLI tools or applications
- When you want automatic state management
- When you need steering/follow-up message queues
- Rapid prototyping

```typescript
const agent = new Agent({ initialState: { ... } });
agent.subscribe((event) => { ... });
await agent.prompt("Hello");
// State is managed automatically
```

### When to use `agentLoop` (low-level)

- Integrating with existing state management (Redux, Zustand, etc.)
- Building custom agent wrappers
- When you need full control over the message flow
- Server-side streaming where you control the event loop

```typescript
const context: AgentContext = { systemPrompt: "...", messages: [], tools: [] };
const config: AgentLoopConfig = { model, convertToLlm: (msgs) => msgs };

for await (const event of agentLoop([userMessage], context, config)) {
  if (event.type === "agent_end") {
    // YOU must update context manually
    context.messages.push(...event.messages);
  }
}
```

### Key difference: State management

The `Agent` class manages state internally and provides methods like `setTools()`, `setModel()`, and `replaceMessages()`. The context is updated automatically after each agent run.

With `agentLoop`, **you are responsible for state**:
- The original context is **not mutated**
- New messages are returned via the `agent_end` event
- You must update `context.messages` yourself

See [`docs/minimal-example/low-level-agent.ts`](./minimal-example/low-level-agent.ts) for a complete low-level example.

---

## Production Bash Tool Patterns

The minimal example above works, but production tools need more. Here are patterns from pi-coding-agent's [bash.ts](../../coding-agent/src/core/tools/bash.ts):

### Output Truncation

Large command outputs can overwhelm context windows. Truncate to keep the most recent output:

```typescript
const MAX_BYTES = 30 * 1024; // 30KB
const MAX_LINES = 300;

function truncateTail(text: string): { content: string; truncated: boolean } {
  const lines = text.split("\n");

  // Check line limit
  if (lines.length > MAX_LINES) {
    const kept = lines.slice(-MAX_LINES);
    return {
      content: kept.join("\n"),
      truncated: true,
    };
  }

  // Check byte limit
  if (Buffer.byteLength(text, "utf-8") > MAX_BYTES) {
    // Keep last MAX_BYTES
    let result = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] + "\n";
      if (Buffer.byteLength(result + line, "utf-8") > MAX_BYTES) break;
      result = line + result;
    }
    return { content: result, truncated: true };
  }

  return { content: text, truncated: false };
}
```

### Timeout Handling

Set timeouts to prevent runaway commands:

```typescript
execute: async (toolCallId, { command, timeout }, signal, onUpdate) => {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { /* ... */ });

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (timeout !== undefined && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout * 1000);
    }

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (timedOut) {
        reject(new Error(`Command timed out after ${timeout} seconds`));
        return;
      }

      // ... handle normal completion
    });
  });
};
```

### Process Tree Cleanup

Kill child processes when aborting:

```typescript
import { exec } from "child_process";

function killProcessTree(pid: number) {
  // macOS/Linux: kill process group
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Fallback: use pkill
    exec(`pkill -TERM -P ${pid}`);
  }
}

// In execute:
const child = spawn("bash", ["-c", command], {
  detached: true, // Create new process group
  // ...
});

const onAbort = () => {
  if (child.pid) killProcessTree(child.pid);
};
```

### Error Handling: Throw, Don't Return

When a tool fails, **throw an error**. Don't return error messages as content.

```typescript
// Good: Throw on failure
if (code !== 0) {
  throw new Error(`Command failed with exit code ${code}\n\n${output}`);
}

// Bad: Returning error as content
// The LLM may not realize this is an error
return {
  content: [{ type: "text", text: `Error: exit code ${code}` }],
  details: {},
};
```

The agent catches thrown errors and reports them to the LLM with `isError: true`, which helps the model understand something went wrong.

---

## Agent Wrapper Pattern

pi-coding-agent wraps the `Agent` class in `AgentSession` to add convenience features. Here's why and how:

### Why Wrap?

The raw `Agent` class is minimal by design. Real applications need:

- Tool registry for dynamic tool management
- Event persistence and logging
- Model/thinking level cycling
- Session save/restore
- Auto-retry on transient failures

### Tool Registry Pattern

Instead of passing tools directly, maintain a registry:

```typescript
class AgentSession {
  private agent: Agent;
  private toolRegistry: Map<string, AgentTool> = new Map();
  private activeTools: Set<string> = new Set();

  constructor(agent: Agent) {
    this.agent = agent;
  }

  // Register a tool (doesn't activate it)
  registerTool(tool: AgentTool) {
    this.toolRegistry.set(tool.name, tool);
  }

  // Activate/deactivate tools dynamically
  setActiveTools(toolNames: string[]) {
    this.activeTools = new Set(toolNames);
    const tools = toolNames
      .map((name) => this.toolRegistry.get(name))
      .filter((t): t is AgentTool => t !== undefined);
    this.agent.setTools(tools);
  }

  // Get all registered tools
  getRegisteredTools(): AgentTool[] {
    return Array.from(this.toolRegistry.values());
  }
}
```

This allows you to:
- Register tools once at startup
- Enable/disable tools based on context
- List available tools in help commands

### Event Persistence

Subscribe to events and persist for session replay:

```typescript
class AgentSession {
  private eventLog: AgentEvent[] = [];

  constructor(agent: Agent) {
    agent.subscribe((event) => {
      this.eventLog.push(event);
      this.persist();
    });
  }

  private persist() {
    // Save to disk, database, etc.
    fs.writeFileSync(
      this.sessionPath,
      JSON.stringify({
        messages: this.agent.state.messages,
        events: this.eventLog,
      })
    );
  }

  static restore(sessionPath: string): AgentSession {
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    const agent = new Agent({
      initialState: { messages: data.messages },
    });
    const session = new AgentSession(agent);
    session.eventLog = data.events;
    return session;
  }
}
```

---

## Tool Extension Pattern

pi-coding-agent wraps tools to add extension hooks. This enables plugins to intercept tool calls without modifying tools.

### Wrapping a Tool

```typescript
function wrapTool<T>(
  tool: AgentTool<any, T>,
  hooks: {
    onBeforeExecute?: (toolCall: { name: string; args: any }) => Promise<{ block?: boolean; reason?: string }>;
    onAfterExecute?: (result: AgentToolResult<T>) => Promise<AgentToolResult<T>>;
  }
): AgentTool<any, T> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // Pre-execution hook
      if (hooks.onBeforeExecute) {
        const check = await hooks.onBeforeExecute({ name: tool.name, args: params });
        if (check.block) {
          throw new Error(check.reason || "Tool execution blocked");
        }
      }

      // Execute the actual tool
      const result = await tool.execute(toolCallId, params, signal, onUpdate);

      // Post-execution hook
      if (hooks.onAfterExecute) {
        return hooks.onAfterExecute(result);
      }

      return result;
    },
  };
}
```

### Use Cases

**Permission checking:**

```typescript
const wrappedBash = wrapTool(bashTool, {
  onBeforeExecute: async ({ args }) => {
    if (args.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command blocked" };
    }
    return {};
  },
});
```

**Logging:**

```typescript
const wrappedBash = wrapTool(bashTool, {
  onBeforeExecute: async ({ name, args }) => {
    console.log(`[AUDIT] Tool ${name} called with:`, args);
    return {};
  },
  onAfterExecute: async (result) => {
    console.log(`[AUDIT] Tool returned:`, result.content[0]?.text?.slice(0, 100));
    return result;
  },
});
```

**Result transformation:**

```typescript
const wrappedRead = wrapTool(readTool, {
  onAfterExecute: async (result) => {
    // Redact secrets from file contents
    const text = result.content[0]?.text || "";
    const redacted = text.replace(/API_KEY=\w+/g, "API_KEY=[REDACTED]");
    return {
      ...result,
      content: [{ type: "text", text: redacted }],
    };
  },
});
```

---

## Multiple Run Modes

pi-coding-agent uses the same `AgentSession` with different I/O adapters:

### Interactive Mode (TUI)

Full terminal UI with streaming output, history, and keybindings:

```typescript
class InteractiveMode {
  constructor(private session: AgentSession) {}

  async run() {
    const readline = createInterface({ input: stdin, output: stdout });

    while (true) {
      const input = await readline.question("> ");
      if (input === "/exit") break;

      await this.session.prompt(input);
    }
  }
}
```

### Print Mode (Single-shot)

Execute one prompt and exit:

```typescript
class PrintMode {
  constructor(private session: AgentSession) {}

  async run(prompt: string) {
    // Subscribe to stream output
    this.session.agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

    await this.session.prompt(prompt);
    process.exit(0);
  }
}
```

### RPC Mode (Server)

Expose the agent over JSON-RPC:

```typescript
class RpcMode {
  constructor(private session: AgentSession) {}

  async run() {
    const server = createServer((req, res) => {
      // Handle JSON-RPC requests
      // Map to session.prompt(), session.abort(), etc.
    });
    server.listen(3000);
  }
}
```

The key insight: **all modes share the same AgentSession and tools**. The mode just changes how input/output is handled.

### HTTP Server Example

For a production-ready HTTP server with Server-Sent Events (SSE) streaming, see [`docs/minimal-example/server.ts`](./minimal-example/server.ts). It demonstrates:

- `GET /health` - Health check endpoint
- `POST /prompt` - Accept JSON `{ "message": "..." }` and stream SSE events
- CORS headers for browser compatibility
- Graceful shutdown handling

**Key streaming pattern:**

```typescript
// Set up SSE headers
res.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
});

// Subscribe to agent events and stream via SSE
agent.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        res.write(`event: text\ndata: ${JSON.stringify({ delta: event.assistantMessageEvent.delta })}\n\n`);
      }
      break;
    case "tool_execution_start":
      res.write(`event: tool_start\ndata: ${JSON.stringify({ tool: event.toolName })}\n\n`);
      break;
    case "agent_end":
      res.write(`event: done\ndata: ${JSON.stringify({ messages: event.messages })}\n\n`);
      res.end();
      break;
  }
});

await agent.prompt(message);
```

**Test with curl:**

```bash
curl -X POST http://localhost:3000/prompt \
  -H "Content-Type: application/json" \
  -d '{"message": "List files in the current directory"}'
```

---

## Configuration Patterns

### Dynamic API Key Resolution

For tokens that expire during long-running operations:

```typescript
const agent = new Agent({
  getApiKey: async (provider) => {
    if (provider === "github") {
      // Refresh OAuth token if expired
      return await refreshGitHubToken();
    }
    // Fall back to environment variables
    return process.env[`${provider.toUpperCase()}_API_KEY`];
  },
});
```

### Context Transformation

Transform the message context before each LLM call:

```typescript
const agent = new Agent({
  transformContext: async (messages, signal) => {
    // Example: Inject current time
    const timeMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: `Current time: ${new Date().toISOString()}` }],
      timestamp: Date.now(),
    };

    // Example: Prune old messages if context is too large
    if (messages.length > 100) {
      return [timeMessage, ...messages.slice(-50)];
    }

    return [timeMessage, ...messages];
  },
});
```

### Thinking Budgets

Configure token budgets for thinking/reasoning modes:

```typescript
const agent = new Agent({
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});

// Set thinking level
agent.setThinkingLevel("medium"); // Uses 1024 tokens for thinking
```

### Retry Settings

Control retry behavior for transient failures:

```typescript
const agent = new Agent({
  // Cap retry delay at 60 seconds
  // If server requests longer, fail immediately for user visibility
  maxRetryDelayMs: 60000,
});
```

---

## Model Discovery and Registry

The `@mariozechner/pi-ai` package provides a type-safe model registry with 700+ models from 20+ providers.

### Discovering Available Models

```typescript
import { getModel, getModels, getProviders } from "@mariozechner/pi-ai";

// List all providers
const providers = getProviders();
// ["anthropic", "openai", "google", "amazon-bedrock", "openrouter", ...]

// List all models for a provider
const anthropicModels = getModels("anthropic");
// Returns Model[] with full metadata

// Get a specific model (type-safe - IDE autocomplete works!)
const model = getModel("anthropic", "claude-sonnet-4-20250514");
```

### Model Metadata

Each model includes:

```typescript
interface Model {
  id: string;                    // Model identifier
  name: string;                  // Display name
  api: string;                   // API type (anthropic-messages, openai-completions, etc.)
  provider: string;              // Provider name
  baseUrl: string;               // API endpoint
  reasoning: boolean;            // Supports thinking/reasoning
  input: ("text" | "image")[];   // Supported input types
  cost: {
    input: number;               // $ per million input tokens
    output: number;              // $ per million output tokens
    cacheRead: number;           // $ per million cache read tokens
    cacheWrite: number;          // $ per million cache write tokens
  };
  contextWindow: number;         // Max context tokens
  maxTokens: number;             // Max output tokens
}
```

### How the Model Registry Works

Models are defined in `packages/ai/src/models.generated.ts`, which is **auto-generated** from external APIs:

1. **models.dev API** - Primary source for most providers (Anthropic, OpenAI, Google, etc.)
2. **OpenRouter API** - OpenRouter-specific models
3. **Vercel AI Gateway** - Vercel AI Gateway models

The file is regenerated during build:

```bash
# Regenerate models (fetches latest from APIs)
cd packages/ai
npm run generate-models

# Or regenerate as part of build
npm run build  # runs generate-models automatically
```

### When to Regenerate Models

Regenerate `models.generated.ts` when:

- **New models are released** - e.g., Claude 4, GPT-5
- **Pricing changes** - Keeps cost calculations accurate
- **New providers added** - After updating `generate-models.ts`
- **Model capabilities change** - New features like vision or reasoning

> **Note**: The generated file is ~300KB and committed to the repo. You don't need to regenerate it unless you need the latest models.

### Using Custom Models

For models not in the registry (local inference, private endpoints):

```typescript
import type { Model } from "@mariozechner/pi-ai";

// Custom Ollama model
const ollamaModel: Model<"openai-completions"> = {
  id: "llama-3.1-8b",
  name: "Llama 3.1 8B (Ollama)",
  api: "openai-completions",
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000,
};

const agent = new Agent({
  initialState: {
    model: ollamaModel,
    // ...
  },
});
```

---

## Summary

Building agents with `@mariozechner/pi-agent-core`:

1. **Define tools** with TypeBox schemas and implement `execute` functions
2. **Create an Agent** with initial state (system prompt, model, tools)
3. **Subscribe to events** for UI updates and logging
4. **Call `prompt()`** to run the agent

Or use the low-level `agentLoop` for full control over state management.

Production patterns from pi-coding-agent:

- **Output truncation** to manage context windows
- **Timeout and abort handling** for long-running commands
- **Throw errors** instead of returning error messages
- **Tool registry** for dynamic tool management
- **Tool wrapping** for extension hooks
- **Session persistence** for save/restore
- **Multiple run modes** sharing the same session
- **HTTP server with SSE** for web-based agents

## Resources

- [API Reference](../README.md) - Full API documentation for pi-agent-core
- [pi-ai README](../../ai/README.md) - Model registry, providers, and streaming API
- [Minimal Example](./minimal-example/) - Working examples:
  - `minimal-agent.ts` - High-level Agent class (CLI)
  - `low-level-agent.ts` - Low-level agentLoop (CLI)
  - `server.ts` - HTTP server with SSE streaming
- [pi-coding-agent](../../coding-agent/) - Production agent implementation
