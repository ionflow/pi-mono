// minimal-agent.ts
import "dotenv/config";
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
