/**
 * Strip the common leading-whitespace prefix from a multi-line string so a
 * template literal can sit comfortably inside indented JS source while the
 * file we emit still starts at column 0. Also trims a leading/trailing
 * blank line so the literal can open and close on its own line.
 */
export function dedent(text: string): string {
  let body = text;
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.replace(/\n[ \t]*$/, '\n');

  const lines = body.split('\n');
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return body;
  return lines.map((line) => (line.length >= minIndent ? line.slice(minIndent) : line)).join('\n');
}
