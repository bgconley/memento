# Memento MCP Scaffold (Schemas + Migrations + Test Plan)

This bundle contains:
- Zod tool schemas: `packages/shared/src/schemas.ts`
- Tool name registry: `packages/shared/src/tool-names.ts`
- SQL migrations: `migrations/*.sql`
- Docker compose for Postgres+pgvector: `compose.yaml`
- Golden test plan: `docs/testing.md`
- Example tool fixtures and expected outputs:
  - `packages/core/test/fixtures/tools/*.json`
  - `packages/core/test/golden/tools/*.json`

How to use:
1) Start Postgres:
   docker compose up -d

2) Apply migrations in order (psql):
   for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

3) Implement server handlers and validate outputs:
   ToolSchemas[tool].output.parse(output)

4) Build worker:
   - INGEST_VERSION -> chunk + tsv
   - EMBED_VERSION -> call embedder + store vectors
