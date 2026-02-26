import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCodex, toolSchema, toolAnnotations } from "./helpers.js";

const server = new McpServer({ name: "quorum-codex", version: "1.0.0" });

server.tool(
  "codex_query",
  "Send a read-only prompt to OpenAI Codex CLI (gpt-5.3-codex) and return the structured result",
  toolSchema,
  toolAnnotations,
  ({ prompt, workdir, timeout_ms }) => runCodex(prompt, workdir, timeout_ms)
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
