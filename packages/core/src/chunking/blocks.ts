export type BlockType = "heading" | "paragraph" | "list" | "code_fence" | "table" | "blank";

export type Block = {
  type: BlockType;
  start: number;
  end: number;
  headingPath: string[];
  headingLevel?: number;
  headingText?: string;
};

type Line = {
  line: string;
  start: number;
};

function splitLinesWithOffsets(text: string): Line[] {
  const lines: Line[] = [];
  const regex = /.*?(?:\n|$)/g;
  let match: RegExpExecArray | null;
  let offset = 0;

  while ((match = regex.exec(text)) !== null) {
    const line = match[0];
    if (line.length === 0) break;
    lines.push({ line, start: offset });
    offset += line.length;
  }

  return lines;
}

function isHeading(line: string): RegExpExecArray | null {
  return /^(#{1,6})\s+(.*)$/.exec(line);
}

function isCodeFence(line: string): RegExpExecArray | null {
  return /^(```|~~~)/.exec(line);
}

function isListItem(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?[-]{2,}[:]?\s*(\|\s*:?[-]{2,}[:]?\s*)+\|?\s*$/.test(line);
}

function isTableRow(line: string): boolean {
  return /\|/.test(line);
}

function lineEnd(lines: Line[], index: number): number {
  const line = lines[index];
  return line.start + line.line.length;
}

export function parseBlocks(markdown: string): Block[] {
  const lines = splitLinesWithOffsets(markdown);
  const blocks: Block[] = [];
  const headingStack: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const { line, start } = lines[index];
    const trimmedLine = line.replace(/\n$/, "");
    const trimmed = trimmedLine.trim();

    if (trimmed.length === 0) {
      blocks.push({
        type: "blank",
        start,
        end: start + line.length,
        headingPath: [...headingStack],
      });
      index += 1;
      continue;
    }

    const fenceMatch = isCodeFence(trimmed);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      let endIndex = index;
      while (endIndex + 1 < lines.length) {
        const nextLine = lines[endIndex + 1].line.replace(/\n$/, "").trim();
        endIndex += 1;
        if (isCodeFence(nextLine)?.[1] === fence) {
          break;
        }
      }
      blocks.push({
        type: "code_fence",
        start,
        end: lineEnd(lines, endIndex),
        headingPath: [...headingStack],
      });
      index = endIndex + 1;
      continue;
    }

    const headingMatch = isHeading(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      while (headingStack.length >= level) {
        headingStack.pop();
      }
      headingStack.push(headingText);
      blocks.push({
        type: "heading",
        start,
        end: start + line.length,
        headingPath: [...headingStack],
        headingLevel: level,
        headingText,
      });
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1]?.line.replace(/\n$/, "").trim() ?? "";
    const isTableStart = isTableRow(trimmedLine) && isTableSeparator(nextLine);
    if (isTableStart) {
      let endIndex = index + 1;
      while (endIndex + 1 < lines.length) {
        const candidate = lines[endIndex + 1].line.replace(/\n$/, "");
        if (candidate.trim().length === 0 || !isTableRow(candidate)) {
          break;
        }
        endIndex += 1;
      }
      blocks.push({
        type: "table",
        start,
        end: lineEnd(lines, endIndex),
        headingPath: [...headingStack],
      });
      index = endIndex + 1;
      continue;
    }

    if (isListItem(trimmedLine)) {
      let endIndex = index;
      while (endIndex + 1 < lines.length) {
        const candidate = lines[endIndex + 1].line.replace(/\n$/, "");
        if (candidate.trim().length === 0) break;
        if (isHeading(candidate.trim())) break;
        if (isCodeFence(candidate.trim())) break;
        const tableCandidate = lines[endIndex + 2]?.line.replace(/\n$/, "").trim() ?? "";
        if (isTableRow(candidate) && isTableSeparator(tableCandidate)) break;
        if (!isListItem(candidate) && !/^\s+/.test(candidate)) break;
        endIndex += 1;
      }
      blocks.push({
        type: "list",
        start,
        end: lineEnd(lines, endIndex),
        headingPath: [...headingStack],
      });
      index = endIndex + 1;
      continue;
    }

    let endIndex = index;
    while (endIndex + 1 < lines.length) {
      const candidate = lines[endIndex + 1].line.replace(/\n$/, "");
      const candidateTrimmed = candidate.trim();
      if (candidateTrimmed.length === 0) break;
      if (isHeading(candidateTrimmed)) break;
      if (isCodeFence(candidateTrimmed)) break;
      if (isListItem(candidate)) break;
      const tableCandidate = lines[endIndex + 2]?.line.replace(/\n$/, "").trim() ?? "";
      if (isTableRow(candidate) && isTableSeparator(tableCandidate)) break;
      endIndex += 1;
    }

    blocks.push({
      type: "paragraph",
      start,
      end: lineEnd(lines, endIndex),
      headingPath: [...headingStack],
    });
    index = endIndex + 1;
  }

  return blocks;
}
