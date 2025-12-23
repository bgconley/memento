# Memento MCP Server Usage

This guide follows the implementation plan in `memento-enhanced-spec.md` and the tool contract in `docs/mcp-tools.md`.

## Prerequisites

- Node.js 20+
- pnpm
- Docker (for local Postgres)

## Quick start (local)

1) Install dependencies

```sh
pnpm install
```

2) Start Postgres and apply migrations

```sh
./scripts/db-up.sh
./scripts/migrate.sh
```

3) Build all packages

```sh
pnpm -r build
```

4) Run the worker (outbox processor)

```sh
DATABASE_URL=postgres://memento:memento@localhost:5432/memento \
EMBEDDER_USE_FAKE=1 \
node packages/worker/dist/main.js
```

5) Run the MCP server (STDIO transport)

```sh
DATABASE_URL=postgres://memento:memento@localhost:5432/memento \
node packages/mcp-server/dist/main.js
```

## Embedding provider configuration

Set these environment variables for real embeddings (optional for local dev):

- `EMBEDDER_BASE_URL` (e.g. `http://localhost:8080/v1`)
- `EMBEDDER_API_KEY` (omit if your local endpoint does not require a key)
- `EMBEDDER_USE_FAKE=1` to force deterministic fake embeddings in dev/tests

## Registering with Claude Code

### Project-scoped config (per repo)

Create a `.mcp.json` file at the repo root:

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/memento/packages/mcp-server/dist/main.js"],
      "env": {
        "DATABASE_URL": "postgres://memento:memento@localhost:5432/memento",
        "EMBEDDER_USE_FAKE": "1"
      }
    }
  }
}
```

### User-scoped config (global)

Create `~/.config/claude/mcp.json` with the same JSON structure:

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/memento/packages/mcp-server/dist/main.js"],
      "env": {
        "DATABASE_URL": "postgres://memento:memento@localhost:5432/memento",
        "EMBEDDER_USE_FAKE": "1"
      }
    }
  }
}
```

## Registering with Codex TUI

Create `~/.codex/mcp.json`:

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/memento/packages/mcp-server/dist/main.js"],
      "env": {
        "DATABASE_URL": "postgres://memento:memento@localhost:5432/memento",
        "EMBEDDER_USE_FAKE": "1"
      }
    }
  }
}
```

## Verifying connectivity

Run `health.check` from your MCP client. Expected output includes:

- `database_ok: true`
- `worker_backlog: 0` (or a small number if events are pending)
- `active_embedding_profile_id` when a profile is activated
