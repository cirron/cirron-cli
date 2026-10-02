/**
 * Presentation metadata for `cirron doctor`. Maps each SDK extras group
 * to the section it should render under and a short human note. The
 * authoritative list of extras lives in the installed SDK's METADATA
 * (Requires-Dist lines) — this file only controls how they're displayed.
 *
 * Extras not present here fall into the "Other extras" section at the
 * bottom so newer SDK extras keep rendering with an older CLI.
 */

export type Section =
  | "core"
  | "core_optional"
  | "frameworks"
  | "data"
  | "snapshots"
  | "other";

interface ExtraDisplay {
  /** Short note rendered in the right-hand column when installed. */
  installedNote?: string;
  section: Section;
}

/** Per-extras-group display metadata. Keys match pyproject extras names. */
const EXTRA_DISPLAY: Record<string, ExtraDisplay> = {
  dotenv: { section: "core_optional", installedNote: ".env file support" },

  torch: { section: "frameworks", installedNote: "hooks available" },
  tensorflow: { section: "frameworks", installedNote: "hooks available" },
  transformers: { section: "frameworks", installedNote: "hooks available" },
  sklearn: { section: "frameworks", installedNote: "ci.wrap() available" },

  pandas: { section: "data", installedNote: "default ci.load() backend" },
  polars: { section: "data" },
  arrow: { section: "data" },
  hf: { section: "data", installedNote: "datasets integration" },
  image: { section: "data" },

  safetensors: {
    section: "snapshots",
    installedNote: "sampled/full snapshot capture",
  },
};

/**
 * Per-package dist-name display overrides, keyed by PEP-503-normalized
 * dist name. Used when an extras group bundles more than one dist and we
 * want a friendly note on a specific one (e.g. "datasets" inside [hf]).
 */
const DIST_DISPLAY: Record<string, { installedNote?: string }> = {
  pandas: { installedNote: "default ci.load() backend" },
  datasets: { installedNote: "HuggingFace datasets" },
  safetensors: { installedNote: "sampled/full snapshot capture" },
  torch: { installedNote: "hooks available" },
  tensorflow: { installedNote: "hooks available" },
  transformers: { installedNote: "hooks available" },
  "scikit-learn": { installedNote: "ci.wrap() available" },
  "python-dotenv": { installedNote: ".env file support" },
  pydantic: {},
  pyyaml: {},
  requests: {},
};

/** Hard-required deps that we surface under "Core" when missing. */
export const CORE_DIST_NAMES = [
  "cirron-sdk",
  "pydantic",
  "pyyaml",
  "requests",
] as const;

/** Headings used by the renderer. Sections without entries are skipped. */
export const SECTION_TITLES: Record<Section, string> = {
  core: "Core",
  core_optional: "Core (optional)",
  frameworks: "Frameworks",
  data: "Data",
  snapshots: "Snapshots",
  other: "Other extras",
};

/** Ordered sections for deterministic output. */
export const SECTION_ORDER: Section[] = [
  "core",
  "core_optional",
  "frameworks",
  "data",
  "snapshots",
  "other",
];

/**
 * Which report section an unrecognized check belongs under.
 *
 * @param extra - The SDK extra the check belongs to, or null for core.
 * @returns The section heading to file it beneath.
 */
export function sectionForExtra(extra: string | null): Section {
  if (extra === null) {
    return "core";
  }
  return EXTRA_DISPLAY[extra]?.section ?? "other";
}

/**
 * The pip command that installs a missing SDK extra.
 *
 * @param extra - The extra to install, or null for the base package.
 * @returns A copy-pasteable `pip install` command.
 */
export function installHintFor(extra: string | null): string {
  if (extra === null) {
    return "pip install 'cirron-sdk'";
  }
  return `pip install 'cirron-sdk[${extra}]'`;
}

/**
 * An extra note to show beside a detected package.
 *
 * @param distNameNormalized - Normalized distribution name.
 * @param extra - The extra it came in under, or null.
 * @returns The note, or undefined when nothing is worth saying.
 */
export function noteForPackage(
  distNameNormalized: string,
  extra: string | null
): string | undefined {
  const perDist = DIST_DISPLAY[distNameNormalized]?.installedNote;
  if (perDist) {
    return perDist;
  }
  if (extra !== null) {
    return EXTRA_DISPLAY[extra]?.installedNote;
  }
  return;
}
