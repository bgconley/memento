export type OutlineChunk = {
  section_anchor: string | null;
  heading_path: string[] | null;
  start_char: number | null;
  end_char: number | null;
};

export type OutlineSection = {
  section_anchor: string;
  heading_path: string[];
  start_char: number | null;
  end_char: number | null;
};

export function buildOutlineFromChunks(chunks: OutlineChunk[]): OutlineSection[] {
  const sections = new Map<string, OutlineSection>();

  for (const chunk of chunks) {
    if (!chunk.section_anchor) continue;

    const existing = sections.get(chunk.section_anchor);
    const startChar = chunk.start_char ?? null;
    const endChar = chunk.end_char ?? null;

    if (!existing) {
      sections.set(chunk.section_anchor, {
        section_anchor: chunk.section_anchor,
        heading_path: chunk.heading_path ?? [],
        start_char: startChar,
        end_char: endChar,
      });
      continue;
    }

    if (existing.heading_path.length === 0 && chunk.heading_path?.length) {
      existing.heading_path = chunk.heading_path;
    }

    if (startChar !== null) {
      existing.start_char =
        existing.start_char === null ? startChar : Math.min(existing.start_char, startChar);
    }

    if (endChar !== null) {
      existing.end_char =
        existing.end_char === null ? endChar : Math.max(existing.end_char, endChar);
    }
  }

  return Array.from(sections.values()).sort((a, b) => {
    if (a.start_char === null && b.start_char === null) {
      return a.section_anchor.localeCompare(b.section_anchor);
    }
    if (a.start_char === null) return 1;
    if (b.start_char === null) return -1;
    if (a.start_char !== b.start_char) return a.start_char - b.start_char;
    return a.section_anchor.localeCompare(b.section_anchor);
  });
}
