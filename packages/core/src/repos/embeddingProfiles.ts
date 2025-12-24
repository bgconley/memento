import type { DbClient } from "../db";
import { applyProjectScope, NotFoundError, ValidationError } from "../db";

export type EmbeddingProfileRow = {
  id: string;
  project_id: string;
  name: string;
  provider: string;
  model: string;
  dims: number;
  distance: string;
  is_active: boolean;
  provider_config: Record<string, unknown>;
  created_at: string;
};

export type UpsertEmbeddingProfileInput = {
  project_id: string;
  embedding_profile_id?: string | null;
  name: string;
  provider: string;
  model: string;
  dims: number;
  distance: string;
  provider_config: Record<string, unknown>;
  is_active?: boolean;
};

export async function listEmbeddingProfiles(
  client: DbClient,
  projectId: string,
  includeInactive: boolean
): Promise<EmbeddingProfileRow[]> {
  const scoped = applyProjectScope(
    {
      text: `SELECT id, project_id, name, provider, model, dims, distance, is_active, provider_config, created_at
             FROM embedding_profiles
             WHERE {{project_scope}} ${includeInactive ? "" : "AND is_active = true"}
             ORDER BY created_at DESC`,
      values: [],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows;
}

export async function getEmbeddingProfileById(
  client: DbClient,
  projectId: string,
  embeddingProfileId: string
): Promise<EmbeddingProfileRow | null> {
  const scoped = applyProjectScope(
    {
      text: `SELECT id, project_id, name, provider, model, dims, distance, is_active, provider_config, created_at
             FROM embedding_profiles
             WHERE id = $1 AND {{project_scope}}`,
      values: [embeddingProfileId],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows[0] ?? null;
}

export async function getEmbeddingProfileByName(
  client: DbClient,
  projectId: string,
  name: string
): Promise<EmbeddingProfileRow | null> {
  const scoped = applyProjectScope(
    {
      text: `SELECT id, project_id, name, provider, model, dims, distance, is_active, provider_config, created_at
             FROM embedding_profiles
             WHERE name = $1 AND {{project_scope}}`,
      values: [name],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows[0] ?? null;
}

export async function getActiveEmbeddingProfile(
  client: DbClient,
  projectId: string
): Promise<EmbeddingProfileRow | null> {
  const scoped = applyProjectScope(
    {
      text: `SELECT id, project_id, name, provider, model, dims, distance, is_active, provider_config, created_at
             FROM embedding_profiles
             WHERE {{project_scope}} AND is_active = true
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
      values: [],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows[0] ?? null;
}

export async function upsertEmbeddingProfile(
  client: DbClient,
  input: UpsertEmbeddingProfileInput
): Promise<{ profile: EmbeddingProfileRow; created: boolean }>{
  if (!input.project_id) {
    throw new ValidationError("project_id is required");
  }

  if (input.embedding_profile_id) {
    const scoped = applyProjectScope(
      {
        text: `UPDATE embedding_profiles
               SET name = $2,
                   provider = $3,
                   model = $4,
                   dims = $5,
                   distance = $6,
                   provider_config = $7
               WHERE id = $1 AND {{project_scope}}
               RETURNING id, project_id, name, provider, model, dims, distance, is_active, provider_config, created_at`,
        values: [
          input.embedding_profile_id,
          input.name,
          input.provider,
          input.model,
          input.dims,
          input.distance,
          input.provider_config,
        ],
      },
      input.project_id,
      "project_id"
    );

    const result = await client.query(scoped);
    if (!result.rows[0]) {
      throw new NotFoundError("Embedding profile not found", {
        embedding_profile_id: input.embedding_profile_id,
      });
    }

    return { profile: result.rows[0], created: false };
  }

  const isActive = input.is_active ?? false;

  const result = await client.query(
    `INSERT INTO embedding_profiles (project_id, name, provider, model, dims, distance, is_active, provider_config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project_id, name)
     DO UPDATE SET
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       dims = EXCLUDED.dims,
       distance = EXCLUDED.distance,
       provider_config = EXCLUDED.provider_config
     RETURNING id, project_id, name, provider, model, dims, distance, is_active, provider_config, created_at,
               (xmax = 0) AS created`,
    [
      input.project_id,
      input.name,
      input.provider,
      input.model,
      input.dims,
      input.distance,
      isActive,
      input.provider_config,
    ]
  );

  const row = result.rows[0];
  return { profile: row, created: row.created };
}

export async function activateEmbeddingProfile(
  client: DbClient,
  projectId: string,
  embeddingProfileId: string
): Promise<EmbeddingProfileRow> {
  const existing = await getEmbeddingProfileById(client, projectId, embeddingProfileId);
  if (!existing) {
    throw new NotFoundError("Embedding profile not found", {
      embedding_profile_id: embeddingProfileId,
    });
  }

  await client.query(
    "UPDATE embedding_profiles SET is_active = false WHERE project_id = $1 AND id <> $2",
    [projectId, embeddingProfileId]
  );

  const updated = await client.query(
    `UPDATE embedding_profiles
     SET is_active = true
     WHERE project_id = $1 AND id = $2
     RETURNING id, project_id, name, provider, model, dims, distance, is_active, provider_config, created_at`,
    [projectId, embeddingProfileId]
  );

  return updated.rows[0];
}
