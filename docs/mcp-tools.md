# MCP Tool Contract (Inputs)

This document is generated to be implementation-oriented.

Source of truth:
- `packages/shared/src/schemas.ts`

Conventions:
- Every write tool requires `idempotency_key`.
- Every tool may omit `project_id`; if omitted, server uses the active project associated with the connection (set via `projects.resolve`).

Tools:
- projects.resolve
- projects.list
- sessions.start
- sessions.end
- embedding_profiles.list
- embedding_profiles.upsert
- embedding_profiles.activate
- memory.commit
- memory.get
- memory.search
- memory.restore
- memory.history
- memory.diff
- memory.pin
- memory.unpin
- memory.link
- memory.archive
- canonical.upsert
- canonical.get
- canonical.outline
- canonical.get_section
- canonical.context_pack
- admin.reindex_profile
- admin.reingest_version
- health.check

See `schemas.ts` for exact field definitions and constraints.
