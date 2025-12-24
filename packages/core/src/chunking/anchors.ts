export function slugifyHeading(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.slice(0, 40);
}

export function buildSectionAnchor(headingPath: string[]): string {
  if (headingPath.length === 0) return "root";
  const level = headingPath.length;
  const slugs = headingPath.map((heading) => slugifyHeading(heading));
  return `h${level}:${slugs.join(".")}`;
}
