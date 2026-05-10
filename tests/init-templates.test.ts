import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../src/commands/init";

const EXPECTED_TEMPLATES = [
  "pytorch",
  "tensorflow",
  "sklearn",
  "pytorch-train",
  "tensorflow-train",
  "sklearn-pipeline",
  "custom",
];

describe("init TEMPLATES registry", () => {
  it("exposes all supported templates", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(
      [...EXPECTED_TEMPLATES].sort()
    );
  });

  it.each(
    EXPECTED_TEMPLATES
  )("template %s has name, description, and postInstall", (key) => {
    const tpl = TEMPLATES[key];
    expect(tpl).toBeDefined();
    expect(tpl?.name).toBeTruthy();
    expect(tpl?.description).toBeTruthy();
    expect(Array.isArray(tpl?.postInstall)).toBe(true);
  });
});
