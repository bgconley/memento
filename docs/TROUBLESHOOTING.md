# Memento Troubleshooting

This guide aligns with the operational plan in `memento-enhanced-spec.md`.

## Database is down

Symptoms:
- `health.check` returns `database_ok: false`
- Server logs show connection errors

Fix:

```sh
./scripts/db-up.sh
./scripts/migrate.sh
```

Verify:

```sh
DATABASE_URL=postgres://memento:memento@localhost:5432/memento \
node -e "require('pg').Client({connectionString: process.env.DATABASE_URL}).connect().then(()=>console.log('ok')).catch(console.error)"
```

## Migrations are missing

Symptoms:
- Tables not found
- Worker fails on outbox or chunk/embedding insert

Fix:

```sh
./scripts/migrate.sh
```

## Embedding provider errors

Symptoms:
- Worker logs `embedder_not_configured` or provider connection failures
- `memory.search` returns only lexical results

Fix:

1) Confirm environment variables:
   - `EMBEDDER_BASE_URL`
   - `EMBEDDER_API_KEY` (if required by provider)
2) For local dev, force fake embeddings:

```sh
EMBEDDER_USE_FAKE=1 node packages/worker/dist/main.js
```

## Outbox backlog keeps growing

Symptoms:
- `health.check` shows high `worker_backlog`
- No recent `worker.poll` log entries

Fix:

1) Start or restart the worker:

```sh
DATABASE_URL=postgres://memento:memento@localhost:5432/memento \
node packages/worker/dist/main.js
```

2) Check for repeated errors in worker logs.

## Replaying ingestion/embedding

Use admin tools to re-run ingest or reindex in a safe, idempotent way.

### Re-ingest a version

```json
{
  "tool": "admin.reingest_version",
  "input": {
    "version_id": "<uuid>",
    "idempotency_key": "reingest-<uuid>",
    "include_embedding": true
  }
}
```

### Reindex all chunks for a profile

```json
{
  "tool": "admin.reindex_profile",
  "input": {
    "embedding_profile_id": "<uuid>",
    "idempotency_key": "reindex-<uuid>",
    "mode": "enqueue"
  }
}
```

Keep the worker running so the outbox events are processed.

## No active embedding profile

Symptoms:
- `health.check` returns `active_embedding_profile_id: null`
- Semantic search returns empty results

Fix:

1) Create and activate a profile:

```json
{
  "tool": "embedding_profiles.upsert",
  "input": {
    "idempotency_key": "profile-<uuid>",
    "name": "default",
    "provider": "openai_compat",
    "model": "text-embedding-3-small",
    "dims": 1536,
    "distance": "cosine",
    "provider_config": { "base_url": "http://localhost:8080/v1" },
    "set_active": true
  }
}
```

2) Run `health.check` again to verify.
