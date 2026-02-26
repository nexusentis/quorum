import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runGemini, toolSchema, geminiToolAnnotations } from "./helpers.js";

const server = new McpServer({ name: "quorum-gemini", version: "1.0.0" });

server.tool(
  "gemini_query",
  "Send a prompt to Google Gemini CLI (gemini-3-pro) and return the structured result",
  toolSchema,
  geminiToolAnnotations,
  ({ prompt, workdir, timeout_ms }) => runGemini(prompt, workdir, timeout_ms)
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
