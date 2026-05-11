import { describe, expect, it } from "vitest";
import type { PlanFile } from "../../../src/utils/plan";
import { PlanFormatter } from "../../../src/utils/plan-formatter";

function makePlan(overrides: Partial<PlanFile> = {}): PlanFile {
  return {
    architecture: "cpu",
    artifacts: [
      {
        path: "models/model_cpu.pth",
        type: "model",
        estimatedSize: 50 * 1024 * 1024,
        description: "PyTorch model",
      },
      {
        path: "artifacts/manifest.json",
        type: "metadata",
        estimatedSize: 1024,
        description: "Build metadata",
      },
    ],
    buildSteps: ["pip install -r requirements.txt", "python train.py"],
    command: "compile",
    dependencies: [
      {
        name: "torch",
        version: "2.0.0",
        category: "ml-framework",
        estimatedSize: 800 * 1024 * 1024,
      },
      {
        name: "numpy",
        version: "1.24.0",
        category: "data-processing",
        estimatedSize: 20 * 1024 * 1024,
      },
    ],
    framework: "pytorch",
    projectName: "demo",
    pythonVersion: "3.10",
    resources: {
      diskSpace: 1024 * 1024 * 1024,
      estimatedTime: 120,
      memory: 4 * 1024 * 1024 * 1024,
    },
    // Fixed timestamp so snapshots stay stable.
    timestamp: "2026-01-01T00:00:00.000Z",
    warnings: [],
    ...overrides,
  };
}

describe("PlanFormatter.formatConsole", () => {
  it("renders without emojis (CLAUDE.md policy)", () => {
    const out = PlanFormatter.formatConsole(makePlan(), {
      useColors: false,
      showDetails: false,
      compact: false,
    });
    // Emoji policy: only 💡 in docs allowed; nothing in logs.
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("uses bracketed text labels in place of removed emoji icons", () => {
    const out = PlanFormatter.formatConsole(makePlan(), {
      useColors: false,
      showDetails: false,
      compact: false,
    });
    // Artifact label for type=model and type=metadata
    expect(out).toContain("[model]");
    expect(out).toContain("[meta]");
    // Dependency category label
    expect(out).toContain("[ml]");
  });

  it("includes core plan facts in the rendered output", () => {
    const out = PlanFormatter.formatConsole(makePlan(), {
      useColors: false,
      showDetails: false,
      compact: false,
    });
    expect(out).toContain("compile");
    expect(out).toContain("cpu");
    expect(out).toContain("pytorch");
    expect(out).toContain("3.10");
    expect(out).toContain("torch");
    expect(out).toContain("models/model_cpu.pth");
  });

  it("compact mode omits the detailed sections", () => {
    const out = PlanFormatter.formatConsole(makePlan(), {
      useColors: false,
      showDetails: false,
      compact: true,
    });
    // Compact still shows the header
    expect(out).toContain("Build Plan Summary:");
    // But should be much shorter than full mode
    const full = PlanFormatter.formatConsole(makePlan(), {
      useColors: false,
      showDetails: false,
      compact: false,
    });
    expect(out.length).toBeLessThan(full.length);
  });
});

describe("PlanFormatter.formatJSON", () => {
  it("round-trips through JSON.parse", () => {
    const plan = makePlan();
    const json = PlanFormatter.formatJSON(plan);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.projectName).toBe("demo");
    expect(parsed.architecture).toBe("cpu");
  });

  it("pretty-prints by default", () => {
    const json = PlanFormatter.formatJSON(makePlan());
    expect(json).toContain("\n");
  });

  it("compact mode produces single-line JSON", () => {
    const json = PlanFormatter.formatJSON(makePlan(), false);
    expect(json.split("\n").length).toBe(1);
  });
});

describe("PlanFormatter.formatSummaryLine", () => {
  it("produces a single line with key facts", () => {
    const line = PlanFormatter.formatSummaryLine(makePlan());
    expect(line.split("\n").length).toBe(1);
    expect(line).toContain("pytorch");
    expect(line).toContain("cpu");
  });
});

describe("PlanFormatter.formatCIOutput", () => {
  it("renders without colors or emojis (CI-safe)", () => {
    const out = PlanFormatter.formatCIOutput(makePlan());
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    // CI output should not contain ANSI escape codes
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
  });
});
