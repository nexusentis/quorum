import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runQuorum, quorumToolSchema, toolAnnotations } from "./helpers.js";

const server = new McpServer({ name: "quorum", version: "1.0.0" });

server.tool(
  "quorum_query",
  "Fan out a prompt to multiple AI agents in parallel and return all results",
  quorumToolSchema,
  toolAnnotations,
  ({ prompt, workdir, timeout_ms, agents }) =>
    runQuorum(prompt, workdir, timeout_ms, agents)
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
