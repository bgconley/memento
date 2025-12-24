import { buildSectionAnchor } from "./anchors";
import { parseBlocks, type Block } from "./blocks";

export type ChunkingConfig = {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
};

export type MarkdownChunk = {
  chunk_index: number;
  chunk_text: string;
  heading_path: string[];
  section_anchor: string;
  start_char: number;
  end_char: number;
};

const DEFAULT_CONFIG: ChunkingConfig = {
  targetTokens: 600,
  maxTokens: 800,
  overlapTokens: 60,
};

function estimateTokensFromSpan(length: number): number {
  return Math.ceil(length / 4);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function splitOversizedBlock(block: Block, maxTokens: number): Block[] {
  if (block.type === "heading") return [block];
  const maxSpan = Math.max(1, Math.floor(maxTokens * 4));
  if (block.end - block.start <= maxSpan) return [block];

  const pieces: Block[] = [];
  for (let start = block.start; start < block.end; start += maxSpan) {
    const end = Math.min(block.end, start + maxSpan);
    pieces.push({ ...block, start, end });
  }
  return pieces;
}

function buildOverlapBlocks(blocks: Block[], overlapTokens: number): Block[] {
  if (overlapTokens <= 0 || blocks.length === 0) return [];
  const tailBlocks: Block[] = [];
  let tokenBudget = 0;
  const anchorHeading = blocks[blocks.length - 1].headingPath;

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!arraysEqual(block.headingPath, anchorHeading)) {
      break;
    }
    tailBlocks.unshift(block);
    tokenBudget += estimateTokensFromSpan(block.end - block.start);
    if (tokenBudget >= overlapTokens) {
      break;
    }
  }

  return tailBlocks;
}

export function chunkMarkdown(markdown: string, config: Partial<ChunkingConfig> = {}): MarkdownChunk[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const blocks = parseBlocks(markdown);
  const chunks: MarkdownChunk[] = [];

  let currentBlocks: Block[] = [];
  let currentHeading: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (currentBlocks.length === 0) return;
    const start = currentBlocks[0].start;
    const end = currentBlocks[currentBlocks.length - 1].end;
    const chunkText = markdown.slice(start, end);
    chunks.push({
      chunk_index: chunks.length,
      chunk_text: chunkText,
      heading_path: [...currentHeading],
      section_anchor: buildSectionAnchor(currentHeading),
      start_char: start,
      end_char: end,
    });

    const overlap = buildOverlapBlocks(currentBlocks, cfg.overlapTokens);
    currentBlocks = overlap;
    currentTokens = overlap.reduce(
      (sum, block) => sum + estimateTokensFromSpan(block.end - block.start),
      0
    );
    currentHeading = currentBlocks.length > 0 ? [...currentBlocks[0].headingPath] : [];
  };

  for (const block of blocks) {
    const blockTokens = estimateTokensFromSpan(block.end - block.start);
    const oversized = blockTokens > cfg.maxTokens;
    if (oversized && currentBlocks.length > 0) {
      flush();
      currentHeading = [...block.headingPath];
    }

    const pieces = oversized ? splitOversizedBlock(block, cfg.maxTokens) : [block];
    for (const piece of pieces) {
      const pieceTokens = estimateTokensFromSpan(piece.end - piece.start);

      if (currentBlocks.length === 0) {
        currentHeading = [...piece.headingPath];
      }

      if (piece.type === "heading" && currentBlocks.length > 0) {
        flush();
        currentHeading = [...piece.headingPath];
      } else if (currentBlocks.length > 0) {
        const headingChanged = !arraysEqual(currentHeading, piece.headingPath);
        if (headingChanged) {
          flush();
          currentHeading = [...piece.headingPath];
        }
      }

      if (currentBlocks.length > 0 && currentTokens + pieceTokens > cfg.targetTokens) {
        flush();
        currentHeading = [...piece.headingPath];
      }

      if (pieceTokens > cfg.maxTokens && currentBlocks.length > 0) {
        flush();
        currentHeading = [...piece.headingPath];
      }

      currentBlocks.push(piece);
      currentTokens += pieceTokens;
    }
  }

  flush();
  return chunks;
}
