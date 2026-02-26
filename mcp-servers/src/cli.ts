#!/usr/bin/env node

// External CLI agents only — Claude uses direct filesystem analysis (no MCP server)
const EXTERNAL_AGENTS = ["codex", "copilot", "cursor", "gemini"] as const;

const ALL_SERVERS = [...EXTERNAL_AGENTS, "quorum"] as const;
type ServerName = (typeof ALL_SERVERS)[number];

const SERVER_MAP: Record<ServerName, string> = {
  codex: "./codex-server.js",
  copilot: "./copilot-server.js",
  cursor: "./cursor-server.js",
  gemini: "./gemini-server.js",
  quorum: "./quorum-server.js",
};

function makeServerEntries(cmd: string, style: "standard" | "vscode") {
  const entries: Record<string, object> = {};
  for (const agent of EXTERNAL_AGENTS) {
    const key = `quorum-${agent}`;
    if (style === "vscode") {
      entries[key] = { type: "stdio", command: "npx", args: [cmd, "--server", agent] };
    } else {
      entries[key] = {
        command: "npx",
        args: [cmd, "--server", agent],
        description: `Quorum: relay to ${agent} (Codex, Copilot, Cursor, Gemini)`,
      };
    }
  }
  // Add combined quorum server
  const quorumKey = "quorum";
  if (style === "vscode") {
    entries[quorumKey] = { type: "stdio", command: "npx", args: [cmd, "--server", "quorum"] };
  } else {
    entries[quorumKey] = {
      command: "npx",
      args: [cmd, "--server", "quorum"],
      description: "Quorum: fan out to all agents in parallel and return collected results",
    };
  }
  return entries;
}

const CONFIGS: Record<string, { path: string; key: string; format: (cmd: string) => object }> = {
  cursor: {
    path: ".cursor/mcp.json",
    key: "mcpServers",
    format: (cmd) => makeServerEntries(cmd, "standard"),
  },
  windsurf: {
    path: ".windsurf/mcp.json",
    key: "mcpServers",
    format: (cmd) => makeServerEntries(cmd, "standard"),
  },
  vscode: {
    path: ".vscode/mcp.json",
    key: "servers",
    format: (cmd) => makeServerEntries(cmd, "vscode"),
  },
  claude: {
    path: ".mcp.json",
    key: "mcpServers",
    format: (cmd) => makeServerEntries(cmd, "standard"),
  },
};

const SUPPORTED_TOOLS = Object.keys(CONFIGS);

function printUsage() {
  console.log(`
quorum-agents — Multi-agent MCP server for Claude, Codex, Copilot, Cursor, and Gemini

Usage:
  npx quorum-agents --server <agent>  Start a single agent MCP server (stdio)
  npx quorum-agents --setup <tool>    Generate MCP config for a specific tool

Agents for --server:
  ${ALL_SERVERS.join(", ")}

Supported tools for --setup:
  ${SUPPORTED_TOOLS.join(", ")}

Examples:
  npx quorum-agents --server codex      → start only the codex MCP server
  npx quorum-agents --setup cursor      → creates .cursor/mcp.json
  npx quorum-agents --setup vscode      → creates .vscode/mcp.json
  npx quorum-agents --setup claude      → creates .mcp.json
  npx quorum-agents --setup windsurf    → creates .windsurf/mcp.json
`);
}

async function setup(tool: string) {
  const config = CONFIGS[tool];
  if (!config) {
    console.error(`Unknown tool: ${tool}`);
    console.error(`Supported: ${SUPPORTED_TOOLS.join(", ")}`);
    process.exit(1);
  }

  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");

  const filePath = resolve(process.cwd(), config.path);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const packageName = "quorum-agents";
  const serverEntry = config.format(packageName);

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, "utf-8");
    try {
      existing = JSON.parse(raw);
    } catch {
      console.error(`Error: ${config.path} exists but contains invalid JSON.`);
      console.error(`Please fix the file or delete it, then run setup again.`);
      process.exit(1);
    }
  } catch (e: unknown) {
    const isNotFound = e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      console.error(`Error: could not read ${config.path}: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }

  const servers = (existing[config.key] as Record<string, unknown>) || {};
  Object.assign(servers, serverEntry);
  existing[config.key] = servers;

  await writeFile(filePath, JSON.stringify(existing, null, 2) + "\n");
  console.log(`Wrote ${config.path}`);
  console.log(`\nMCP server config for ${tool}:`);
  console.log(JSON.stringify(serverEntry, null, 2));
  console.log(`\nRestart ${tool} to pick up the new MCP servers.`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const setupIdx = args.indexOf("--setup");
  if (setupIdx !== -1) {
    const tool = args[setupIdx + 1]?.toLowerCase();
    if (!tool) {
      console.error("Missing tool name. Usage: npx quorum-agents --setup <tool>");
      console.error(`Supported: ${SUPPORTED_TOOLS.join(", ")}`);
      process.exit(1);
    }
    await setup(tool);
    return;
  }

  const serverIdx = args.indexOf("--server");
  if (serverIdx !== -1) {
    const agent = args[serverIdx + 1]?.toLowerCase() as ServerName;
    if (!agent || !(ALL_SERVERS as readonly string[]).includes(agent)) {
      console.error(`Unknown agent: ${agent ?? "(missing)"}`);
      console.error(`Supported: ${ALL_SERVERS.join(", ")}`);
      process.exit(1);
    }
    await import(SERVER_MAP[agent]);
    return;
  }

  // No --server flag: show usage
  printUsage();
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
