import type { Pool } from "pg";
import { chunkMarkdown, normalizeMarkdown } from "@memento/core";
import type { OutboxEvent } from "../outboxPoller";

function parsePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === "string") {
    return JSON.parse(payload) as Record<string, unknown>;
  }
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }
  return {};
}

export async function ingestVersion(event: OutboxEvent, pool: Pool): Promise<void> {
  const payload = parsePayload(event.payload);
  const versionId = payload.version_id as string | undefined;

  if (!versionId) {
    throw new Error("INGEST_VERSION missing version_id");
  }

  const versionResult = await pool.query(
    `SELECT mv.id,
            mv.project_id,
            mv.content_text,
            mv.content_json,
            mv.content_format,
            mi.doc_class,
            mi.canonical_key,
            (cd.id IS NOT NULL) AS is_canonical
     FROM memory_versions mv
     JOIN memory_items mi ON mv.item_id = mi.id
     LEFT JOIN canonical_docs cd
       ON cd.item_id = mv.item_id AND cd.project_id = mv.project_id
     WHERE mv.id = $1`,
    [versionId]
  );

  const version = versionResult.rows[0];
  if (!version) {
    throw new Error(`Version not found: ${versionId}`);
  }

  const markdown = normalizeMarkdown({
    format: version.content_format,
    text: version.content_text,
    json: version.content_json,
  });

  const canonicalDocClasses = new Set(["app_spec", "feature_spec", "implementation_plan"]);
  const isCanonical = Boolean(version.is_canonical) || Boolean(version.canonical_key);
  const docClass = typeof version.doc_class === "string" ? version.doc_class : null;
  const disableOverlap =
    isCanonical && docClass !== null && canonicalDocClasses.has(docClass);

  const chunks = chunkMarkdown(markdown, disableOverlap ? { overlapTokens: 0 } : {});

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM memory_chunks WHERE version_id = $1", [versionId]);

    if (chunks.length > 0) {
      const batchSize = 200;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let index = 1;

        for (const chunk of batch) {
          const chunkText = markdown.slice(chunk.start_char, chunk.end_char);
          placeholders.push(
            `($${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5}, $${index + 6}, $${index + 7}, to_tsvector('english', $${index + 3}))`
          );
          values.push(
            version.project_id,
            versionId,
            chunk.chunk_index,
            chunkText,
            chunk.heading_path,
            chunk.section_anchor,
            chunk.start_char,
            chunk.end_char
          );
          index += 8;
        }

        await client.query(
          `INSERT INTO memory_chunks (
            project_id,
            version_id,
            chunk_index,
            chunk_text,
            heading_path,
            section_anchor,
            start_char,
            end_char,
            tsv
          ) VALUES ${placeholders.join(", ")}`,
          values
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
