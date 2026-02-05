// low-level-agent.ts - Using agentLoop directly for fine-grained control
import "dotenv/config";
import { agentLoop, agentLoopContinue } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentTool,
  AgentMessage,
} from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

// Define bash tool (same as high-level example)
const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

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

// 1. Create the context - YOU manage this state
const context: AgentContext = {
  systemPrompt: "You are a helpful CLI assistant. Use the bash tool to help users.",
  messages: [],
  tools: [bashTool],
};

// 2. Create the config - includes model and message conversion
const config: AgentLoopConfig = {
  model: getModel("anthropic", "claude-sonnet-4-20250514"),

  // Required: Convert AgentMessage[] to LLM-compatible Message[]
  // This is where you filter custom message types or transform messages
  convertToLlm: (messages: AgentMessage[]): Message[] => {
    return messages.filter((m): m is Message =>
      ["user", "assistant", "toolResult"].includes(m.role)
    );
  },

  // Optional: Transform context before sending to LLM
  // Use for pruning old messages, injecting context, etc.
  // transformContext: async (messages) => {
  //   if (messages.length > 100) {
  //     return messages.slice(-50); // Keep last 50 messages
  //   }
  //   return messages;
  // },
};

async function main() {
  const prompt = process.argv[2] || "List the files in the current directory";
  console.log(`> ${prompt}\n`);

  // 3. Create the user message
  const userMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  // 4. Run the agent loop - iterate over events
  // The loop automatically handles tool calls and continues until done
  // IMPORTANT: agentLoop does NOT mutate the original context
  // You must capture messages from agent_end and update context yourself
  let newMessages: AgentMessage[] = [];

  for await (const event of agentLoop([userMessage], context, config)) {
    switch (event.type) {
      case "agent_start":
        // Agent is starting
        break;

      case "turn_start":
        // New turn (one LLM call + tool executions)
        break;

      case "message_start":
        // A message is starting (user, assistant, or toolResult)
        break;

      case "message_update":
        // Stream assistant text as it arrives
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        break;

      case "message_end":
        // Message is complete
        break;

      case "tool_execution_start":
        console.log(`\n[Running: ${event.toolName}]`);
        break;

      case "tool_execution_update":
        // Tool is streaming progress (if it uses onUpdate)
        break;

      case "tool_execution_end":
        if (event.isError) {
          console.log(`[Error]`);
        }
        break;

      case "turn_end":
        // Turn complete - includes the assistant message and all tool results
        break;

      case "agent_end":
        // Agent is done - event.messages contains all new messages from this run
        // This includes the user message, assistant messages, and tool results
        newMessages = event.messages;
        break;
    }
  }

  // 5. YOU must update the context manually - this is the key difference from Agent class
  context.messages.push(...newMessages);

  console.log("\n");
  console.log(`[Context now has ${context.messages.length} messages]`);

  // 6. You can continue the conversation by calling agentLoop again with more messages
  //
  // Example: Continue with a follow-up question
  // const followUp: AgentMessage = {
  //   role: "user",
  //   content: [{ type: "text", text: "Now count them" }],
  //   timestamp: Date.now(),
  // };
  // for await (const event of agentLoop([followUp], context, config)) {
  //   if (event.type === "agent_end") {
  //     context.messages.push(...event.messages);
  //   }
  // }
  //
  // Example: Retry from current context (after an error)
  // The last message must be 'user' or 'toolResult' (not 'assistant')
  // for await (const event of agentLoopContinue(context, config)) {
  //   if (event.type === "agent_end") {
  //     context.messages.push(...event.messages);
  //   }
  // }
}

main().catch(console.error);
