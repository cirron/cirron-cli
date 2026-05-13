import { describe, expect, it } from "vitest";
import type { PlanFile } from "../../../src/utils/plan";
import { PlanDiffAnalyzer } from "../../../src/utils/plan-diff";

function basePlan(overrides: Partial<PlanFile> = {}): PlanFile {
  return {
    architecture: "cpu",
    artifacts: [
      {
        path: "models/model_cpu.pth",
        type: "model",
        estimatedSize: 1024,
        description: "PyTorch model",
      },
    ],
    buildSteps: ["pip install -r requirements.txt"],
    command: "compile",
    dependencies: [
      {
        name: "torch",
        version: "2.0.0",
        category: "ml-framework",
        estimatedSize: 100,
      },
    ],
    framework: "pytorch",
    projectName: "demo",
    pythonVersion: "3.10",
    resources: { diskSpace: 1024, estimatedTime: 60, memory: 1024 },
    timestamp: "2026-01-01T00:00:00.000Z",
    warnings: [],
    ...overrides,
  };
}

describe("PlanDiffAnalyzer.comparePlans", () => {
  it("reports no differences when plans are identical", () => {
    const cmp = PlanDiffAnalyzer.comparePlans(basePlan(), basePlan());
    expect(cmp.differences).toHaveLength(0);
  });

  it("detects architecture change", () => {
    const cmp = PlanDiffAnalyzer.comparePlans(
      basePlan(),
      basePlan({ architecture: "cuda" })
    );
    const archDiff = cmp.differences.find((d) => d.field === "architecture");
    expect(archDiff).toBeDefined();
    expect(archDiff?.type).toBe("changed");
    expect(archDiff?.oldValue).toBe("cpu");
    expect(archDiff?.newValue).toBe("cuda");
  });

  it("detects python version change", () => {
    const cmp = PlanDiffAnalyzer.comparePlans(
      basePlan(),
      basePlan({ pythonVersion: "3.11" })
    );
    expect(
      cmp.differences.some(
        (d) => d.field === "pythonVersion" && d.type === "changed"
      )
    ).toBe(true);
  });

  it("detects added dependency", () => {
    const planA = basePlan();
    const planB = basePlan({
      dependencies: [
        ...planA.dependencies,
        {
          name: "numpy",
          version: "1.24.0",
          category: "data-processing",
          estimatedSize: 50,
        },
      ],
    });
    const cmp = PlanDiffAnalyzer.comparePlans(planA, planB);
    const added = cmp.differences.find(
      (d) => d.field === "dependency.numpy" && d.type === "added"
    );
    expect(added).toBeDefined();
  });

  it("detects removed dependency", () => {
    const planA = basePlan();
    const planB = basePlan({ dependencies: [] });
    const cmp = PlanDiffAnalyzer.comparePlans(planA, planB);
    expect(
      cmp.differences.some(
        (d) => d.field === "dependency.torch" && d.type === "removed"
      )
    ).toBe(true);
  });

  it("detects dependency version change", () => {
    const planA = basePlan();
    const planB = basePlan({
      dependencies: [
        {
          name: "torch",
          version: "2.1.0",
          category: "ml-framework",
          estimatedSize: 100,
        },
      ],
    });
    const cmp = PlanDiffAnalyzer.comparePlans(planA, planB);
    expect(
      cmp.differences.some(
        (d) => d.field === "dependency.torch" && d.type === "changed"
      )
    ).toBe(true);
  });

  it("captures plan metadata in the comparison summary", () => {
    const cmp = PlanDiffAnalyzer.comparePlans(
      basePlan({ framework: "pytorch" }),
      basePlan({ framework: "tensorflow" })
    );
    expect(cmp.planA.framework).toBe("pytorch");
    expect(cmp.planB.framework).toBe("tensorflow");
    expect(cmp.summary).toBeDefined();
  });
});

describe("PlanDiffAnalyzer.formatComparison", () => {
  it("emits 'No differences found' when plans are identical", () => {
    const cmp = PlanDiffAnalyzer.comparePlans(basePlan(), basePlan());
    const out = PlanDiffAnalyzer.formatComparison(cmp, false);
    expect(out).toMatch(/No differences found/);
  });

  it("renders without emojis (CLAUDE.md policy)", () => {
    const cmp = PlanDiffAnalyzer.comparePlans(
      basePlan(),
      basePlan({ architecture: "cuda", pythonVersion: "3.11" })
    );
    const out = PlanDiffAnalyzer.formatComparison(cmp, false);
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("uses bracketed [category] labels for diff entries", () => {
    const cmp = PlanDiffAnalyzer.comparePlans(
      basePlan(),
      basePlan({ architecture: "cuda" })
    );
    const out = PlanDiffAnalyzer.formatComparison(cmp, false);
    // architecture change → config category
    expect(out).toContain("[config]");
  });
});
