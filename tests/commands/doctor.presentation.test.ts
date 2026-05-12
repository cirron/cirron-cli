import { describe, expect, it } from "vitest";
import {
  CORE_DIST_NAMES,
  installHintFor,
  noteForPackage,
  SECTION_ORDER,
  SECTION_TITLES,
  sectionForExtra,
} from "../../src/commands/doctor.presentation";

/**
 * doctor.presentation.ts is pure metadata + lookup functions; verify the
 * mappings and the "unknown extra → other" fallback rules.
 */
describe("doctor.presentation", () => {
  describe("sectionForExtra", () => {
    it("null extra maps to the core section", () => {
      expect(sectionForExtra(null)).toBe("core");
    });

    it("known extras map to their declared section", () => {
      expect(sectionForExtra("torch")).toBe("frameworks");
      expect(sectionForExtra("tensorflow")).toBe("frameworks");
      expect(sectionForExtra("transformers")).toBe("frameworks");
      expect(sectionForExtra("sklearn")).toBe("frameworks");
      expect(sectionForExtra("pandas")).toBe("data");
      expect(sectionForExtra("polars")).toBe("data");
      expect(sectionForExtra("hf")).toBe("data");
      expect(sectionForExtra("safetensors")).toBe("snapshots");
      expect(sectionForExtra("dotenv")).toBe("core_optional");
    });

    it("unknown extras fall back to 'other'", () => {
      expect(sectionForExtra("brand-new-extra")).toBe("other");
    });
  });

  describe("installHintFor", () => {
    it("null extra suggests the base package", () => {
      expect(installHintFor(null)).toBe("pip install 'cirron-sdk'");
    });

    it("a named extra is wrapped in the extras bracket", () => {
      expect(installHintFor("torch")).toBe("pip install 'cirron-sdk[torch]'");
      expect(installHintFor("hf")).toBe("pip install 'cirron-sdk[hf]'");
    });
  });

  describe("noteForPackage", () => {
    it("returns a per-dist note when one exists (ignoring the extra)", () => {
      expect(noteForPackage("pandas", "data")).toMatch(/ci\.load\(\)/);
      expect(noteForPackage("datasets", "hf")).toMatch(/HuggingFace datasets/);
      expect(noteForPackage("scikit-learn", "sklearn")).toMatch(/ci\.wrap\(\)/);
      expect(noteForPackage("python-dotenv", "dotenv")).toMatch(/\.env file/);
    });

    it("falls back to the extras-group note when there's no per-dist note", () => {
      // 'polars' has no DIST_DISPLAY note but its extra ('polars') also has no
      // installedNote, so this is undefined; 'image' likewise.
      expect(noteForPackage("polars", "polars")).toBeUndefined();
      // An extra WITH an installedNote and a dist with none → uses the extra's.
      expect(noteForPackage("some-other-torch-dist", "torch")).toBe(
        "hooks available"
      );
    });

    it("returns undefined for unknown dist + null extra", () => {
      expect(noteForPackage("totally-unknown", null)).toBeUndefined();
    });

    it("dist with an empty DIST_DISPLAY entry yields undefined", () => {
      // pydantic / pyyaml / requests have {} entries (no installedNote).
      expect(noteForPackage("pydantic", null)).toBeUndefined();
      expect(noteForPackage("pyyaml", null)).toBeUndefined();
    });
  });

  describe("constants", () => {
    it("CORE_DIST_NAMES lists the hard-required deps", () => {
      expect(CORE_DIST_NAMES).toContain("cirron-sdk");
      expect(CORE_DIST_NAMES).toContain("pydantic");
      expect(CORE_DIST_NAMES).toContain("pyyaml");
      expect(CORE_DIST_NAMES).toContain("requests");
    });

    it("SECTION_ORDER and SECTION_TITLES cover the same sections", () => {
      expect(new Set(SECTION_ORDER)).toEqual(
        new Set(Object.keys(SECTION_TITLES))
      );
      // 'core' first, 'other' last.
      expect(SECTION_ORDER[0]).toBe("core");
      expect(SECTION_ORDER.at(-1)).toBe("other");
    });
  });
});
