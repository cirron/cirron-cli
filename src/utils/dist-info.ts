import fs from 'fs';
import path from 'path';

export interface InstalledPackage {
  name: string;
  version: string;
  metadataPath: string;
}

export interface RequiresDistEntry {
  /** Raw requirement expression without the marker suffix (e.g. "pandas>=2.0"). */
  requirement: string;
  /** Just the distribution name extracted from the requirement. */
  distName: string;
  /** Extras group from `; extra == "group"` marker, or null for hard requirements. */
  extra: string | null;
  /** Raw line, preserved for debugging. */
  raw: string;
}

/** PEP 503 normalization: lowercase, collapse runs of [-_.] to single '-'. */
export function normalizeDistName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Find an installed package's dist-info in site-packages. Matches any
 * dist-info whose prefix normalizes to the requested dist name.
 */
export function findInstalledPackage(
  sitePackages: string,
  distName: string,
): InstalledPackage | null {
  const normalized = normalizeDistName(distName);
  let entries: string[];
  try {
    entries = fs.readdirSync(sitePackages);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.dist-info')) continue;
    const stem = entry.slice(0, -'.dist-info'.length);
    const dashIdx = stem.lastIndexOf('-');
    if (dashIdx < 0) continue;
    const namePart = stem.slice(0, dashIdx);
    if (normalizeDistName(namePart) !== normalized) continue;
    const metadataPath = path.join(sitePackages, entry, 'METADATA');
    const parsed = readMetadata(metadataPath);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Parse a METADATA file's header block (RFC 822). Stops at the first blank
 * line — everything after is the long description.
 */
function readMetadata(metadataPath: string): InstalledPackage | null {
  let text: string;
  try {
    text = fs.readFileSync(metadataPath, 'utf8');
  } catch {
    return null;
  }
  const headers = parseRfc822Headers(text);
  const name = headers.get('name');
  const version = headers.get('version');
  if (!name || !version) return null;
  return { name, version, metadataPath };
}

/**
 * Parse all `Requires-Dist:` lines from a METADATA file, splitting off the
 * `; extra == "group"` marker when present. Other markers
 * (`python_version`, `sys_platform`, etc.) are preserved inside the
 * requirement string but do not flag an extras group.
 */
export function readRequiresDist(metadataPath: string): RequiresDistEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(metadataPath, 'utf8');
  } catch {
    return [];
  }
  const entries: RequiresDistEntry[] = [];
  for (const { key, value } of iterHeaderLines(text)) {
    if (key.toLowerCase() !== 'requires-dist') continue;
    entries.push(parseRequiresDist(value));
  }
  return entries;
}

function parseRequiresDist(line: string): RequiresDistEntry {
  const raw = line;
  let requirement = line.trim();
  let extra: string | null = null;

  const semiIdx = requirement.indexOf(';');
  if (semiIdx >= 0) {
    const marker = requirement.slice(semiIdx + 1).trim();
    requirement = requirement.slice(0, semiIdx).trim();
    const match = marker.match(/extra\s*==\s*["']([^"']+)["']/);
    if (match) {
      extra = match[1] ?? null;
    }
  }

  const distName = extractDistName(requirement);
  return { requirement, distName, extra, raw };
}

/** Grab just the project-name token from a PEP 508 requirement string. */
function extractDistName(requirement: string): string {
  const trimmed = requirement.trim();
  const match = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return match?.[1] ?? trimmed;
}

function parseRfc822Headers(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const { key, value } of iterHeaderLines(text)) {
    const lower = key.toLowerCase();
    if (!map.has(lower)) map.set(lower, value);
  }
  return map;
}

function* iterHeaderLines(text: string): IterableIterator<{ key: string; value: string }> {
  const lines = text.split(/\r?\n/);
  let current: { key: string; value: string } | null = null;
  for (const line of lines) {
    if (line === '') {
      if (current) {
        yield current;
        current = null;
      }
      // Blank line ends the header block.
      return;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && current) {
      current.value += '\n' + line.trim();
      continue;
    }
    if (current) yield current;
    const idx = line.indexOf(':');
    if (idx < 0) {
      current = null;
      continue;
    }
    current = { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
  }
  if (current) yield current;
}
