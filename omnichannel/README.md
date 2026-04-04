# Omnichannel

Bun + TypeScript stack: a **gateway** (webhooks, SQLite ingress, Unix IPC) and an **MCP server** on stdio (`omni_context`, `omni_dispatch`, plus the Claude Code **`claude/channel`** surface) talking to that IPC.

## Claude Code (channel without a plugin)

You do **not** need a separate plugin package: register the MCP server directly, then start Claude with the development channel flag.

1. **Dependencies** — from this directory:

   ```bash
   bun install
   ```

2. **Gateway** — in another terminal, run the host entry (`gateway-host.ts`) so the IPC socket exists (see `omni.yaml` / `OMNI_IPC_SOCKET`). The `@omnibot/gateway` library is channel-agnostic; this repo’s host wires Discord and webhooks via runtime `import()`.

   ```bash
   bun run gateway
   ```

3. **Register the MCP server** (stdio). Run from this repo root so `bun` resolves the workspace scripts:

   ```bash
   claude mcp add --transport stdio bun run omni mcp
   ```

4. **Start a session** with the custom channel allowlist bypass (required for research preview while the server is not on Anthropic’s allowlist):

   ```bash
   claude --dangerously-load-development-channels server:omni
   ```

The `omni` npm script runs the same entry as `bun run mcp` (the stdio MCP server). If your `claude mcp add` syntax differs, follow `claude mcp add --help`; keep the registered server name aligned with **`server:omni`**.

## Environment

| Variable | Purpose |
|----------|--------|
| `OMNI_IPC_SOCKET` | Path to the gateway Unix socket. If unset, the MCP server resolves a default next to `omni.yaml` (typically `./omni-gateway.sock` from the repo root). |
| `OMNI_IPC_TOKEN` | Optional; must match `gateway.sharedSecret` when set. |

Run the gateway from the **same working directory** you use for MCP (or point both at the same socket path) so the client and server agree on the socket file.

**HTTP bind:** by default the gateway listens on **`127.0.0.1`** only (`gateway.httpHostname` in `omni.yaml`). Override with `httpHostname: "0.0.0.0"` only if you need to reach the webhook port from another machine.

**Omni-to-omni (`channel-o2o`):** see [packages/channels/o2o/README.md](packages/channels/o2o/README.md).

## Docs

- [Channels reference](https://code.claude.com/docs/en/channels-reference) — `claude/channel` notifications and two-way tools.
- [MCP in Claude Code](https://code.claude.com/docs/en/mcp) — configuring MCP servers.
