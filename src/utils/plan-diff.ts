import chalk from "chalk";
import type { PlanComparison, PlanDiff } from "../types";
import type { PlanFile } from "./plan";

export class PlanDiffAnalyzer {
  static comparePlans(planA: PlanFile, planB: PlanFile): PlanComparison {
    const differences: PlanDiff[] = [];

    // Compare basic properties
    PlanDiffAnalyzer.compareBasicProperties(planA, planB, differences);

    // Compare dependencies
    PlanDiffAnalyzer.compareDependencies(planA, planB, differences);

    // Compare artifacts
    PlanDiffAnalyzer.compareArtifacts(planA, planB, differences);

    // Compare model shape
    PlanDiffAnalyzer.compareModelShape(planA, planB, differences);

    // Compare resources
    PlanDiffAnalyzer.compareResources(planA, planB, differences);

    // Compare build steps
    PlanDiffAnalyzer.compareBuildSteps(planA, planB, differences);

    // Generate summary
    const summary = PlanDiffAnalyzer.generateSummary(differences);

    return {
      planA: {
        timestamp: planA.timestamp,
        command: planA.command,
        framework: planA.framework,
      },
      planB: {
        timestamp: planB.timestamp,
        command: planB.command,
        framework: planB.framework,
      },
      differences,
      summary,
    };
  }

  private static compareBasicProperties(
    planA: PlanFile,
    planB: PlanFile,
    differences: PlanDiff[]
  ): void {
    const properties = [
      { field: "command", category: "config" as const },
      { field: "framework", category: "config" as const },
      { field: "architecture", category: "config" as const },
      { field: "pythonVersion", category: "config" as const },
    ];

    for (const { field, category } of properties) {
      const valueA = planA[field as keyof PlanFile];
      const valueB = planB[field as keyof PlanFile];

      if (valueA !== valueB) {
        differences.push({
          type: "changed",
          category,
          field,
          oldValue: valueA,
          newValue: valueB,
          impact: PlanDiffAnalyzer.assessImpact(field, valueA, valueB),
          description: `${field} changed from '${valueA}' to '${valueB}'`,
        });
      }
    }
  }

  private static compareDependencies(
    planA: PlanFile,
    planB: PlanFile,
    differences: PlanDiff[]
  ): void {
    const depsA = new Map(planA.dependencies.map((dep) => [dep.name, dep]));
    const depsB = new Map(planB.dependencies.map((dep) => [dep.name, dep]));

    // Check for removed dependencies
    for (const [name, dep] of depsA) {
      if (!depsB.has(name)) {
        differences.push({
          type: "removed",
          category: "dependencies",
          field: `dependency.${name}`,
          oldValue: dep.version,
          newValue: undefined,
          impact: PlanDiffAnalyzer.assessDependencyImpact(dep),
          description: `Dependency '${name}' removed`,
        });
      }
    }

    // Check for added dependencies
    for (const [name, dep] of depsB) {
      if (!depsA.has(name)) {
        differences.push({
          type: "added",
          category: "dependencies",
          field: `dependency.${name}`,
          oldValue: undefined,
          newValue: dep.version,
          impact: PlanDiffAnalyzer.assessDependencyImpact(dep),
          description: `Dependency '${name}' added with version '${dep.version}'`,
        });
      }
    }

    // Check for changed dependencies
    for (const [name, depA] of depsA) {
      const depB = depsB.get(name);
      if (depB && depA.version !== depB.version) {
        differences.push({
          type: "changed",
          category: "dependencies",
          field: `dependency.${name}`,
          oldValue: depA.version,
          newValue: depB.version,
          impact: PlanDiffAnalyzer.assessVersionChangeImpact(
            depA.version,
            depB.version
          ),
          description: `Dependency '${name}' version changed from '${depA.version}' to '${depB.version}'`,
        });
      }
    }
  }

  private static compareArtifacts(
    planA: PlanFile,
    planB: PlanFile,
    differences: PlanDiff[]
  ): void {
    const artifactsA = new Map(planA.artifacts.map((art) => [art.path, art]));
    const artifactsB = new Map(planB.artifacts.map((art) => [art.path, art]));

    // Check for removed artifacts
    for (const [path, artifact] of artifactsA) {
      if (!artifactsB.has(path)) {
        differences.push({
          type: "removed",
          category: "artifacts",
          field: `artifact.${path}`,
          oldValue: artifact.estimatedSize,
          newValue: undefined,
          impact: artifact.type === "model" ? "high" : "medium",
          description: `Artifact '${path}' removed`,
        });
      }
    }

    // Check for added artifacts
    for (const [path, artifact] of artifactsB) {
      if (!artifactsA.has(path)) {
        differences.push({
          type: "added",
          category: "artifacts",
          field: `artifact.${path}`,
          oldValue: undefined,
          newValue: artifact.estimatedSize,
          impact: artifact.type === "model" ? "high" : "medium",
          description: `Artifact '${path}' added`,
        });
      }
    }

    // Check for changed artifacts
    for (const [path, artifactA] of artifactsA) {
      const artifactB = artifactsB.get(path);
      if (artifactB && artifactA.estimatedSize !== artifactB.estimatedSize) {
        const sizeDiff = artifactB.estimatedSize - artifactA.estimatedSize;
        const percentChange = (
          (sizeDiff / artifactA.estimatedSize) *
          100
        ).toFixed(1);

        differences.push({
          type: "changed",
          category: "artifacts",
          field: `artifact.${path}.size`,
          oldValue: artifactA.estimatedSize,
          newValue: artifactB.estimatedSize,
          impact:
            Math.abs(Number.parseFloat(percentChange)) > 50 ? "high" : "medium",
          description: `Artifact '${path}' size changed by ${percentChange}% (${PlanDiffAnalyzer.formatBytes(sizeDiff)})`,
        });
      }
    }
  }

  private static compareModelShape(
    planA: PlanFile,
    planB: PlanFile,
    differences: PlanDiff[]
  ): void {
    const modelA = planA.modelShape;
    const modelB = planB.modelShape;

    if (!modelA && modelB) {
      differences.push({
        type: "added",
        category: "model",
        field: "modelShape",
        oldValue: undefined,
        newValue: modelB,
        impact: "medium",
        description: "Model shape information added",
      });
      return;
    }

    if (modelA && !modelB) {
      differences.push({
        type: "removed",
        category: "model",
        field: "modelShape",
        oldValue: modelA,
        newValue: undefined,
        impact: "medium",
        description: "Model shape information removed",
      });
      return;
    }

    if (!(modelA && modelB)) {
      return;
    }

    // Compare model properties
    const modelProperties = [
      "architecture",
      "totalParameters",
      "trainableParameters",
      "inputShape",
      "outputShape",
      "complexity",
    ];

    for (const prop of modelProperties) {
      const valueA = modelA[prop as keyof typeof modelA];
      const valueB = modelB[prop as keyof typeof modelB];

      if (valueA !== valueB) {
        differences.push({
          type: "changed",
          category: "model",
          field: `modelShape.${prop}`,
          oldValue: valueA,
          newValue: valueB,
          impact: PlanDiffAnalyzer.assessModelChangeImpact(
            prop,
            valueA,
            valueB
          ),
          description: `Model ${prop} changed from '${valueA}' to '${valueB}'`,
        });
      }
    }
  }

  private static compareResources(
    planA: PlanFile,
    planB: PlanFile,
    differences: PlanDiff[]
  ): void {
    const resourceProps = ["diskSpace", "memory", "estimatedTime", "gpuMemory"];

    for (const prop of resourceProps) {
      const valueA = planA.resources[prop as keyof typeof planA.resources];
      const valueB = planB.resources[prop as keyof typeof planB.resources];

      if (valueA !== valueB) {
        const change =
          typeof valueA === "number" && typeof valueB === "number"
            ? `${(((valueB - valueA) / valueA) * 100).toFixed(1)}%`
            : "changed";

        differences.push({
          type: "changed",
          category: "resources",
          field: `resources.${prop}`,
          oldValue: valueA,
          newValue: valueB,
          impact: PlanDiffAnalyzer.assessResourceChangeImpact(
            prop,
            valueA,
            valueB
          ),
          description: `Resource ${prop} ${change}`,
        });
      }
    }
  }

  private static compareBuildSteps(
    planA: PlanFile,
    planB: PlanFile,
    differences: PlanDiff[]
  ): void {
    if (JSON.stringify(planA.buildSteps) !== JSON.stringify(planB.buildSteps)) {
      differences.push({
        type: "changed",
        category: "config",
        field: "buildSteps",
        oldValue: planA.buildSteps,
        newValue: planB.buildSteps,
        impact: "medium",
        description: `Build steps changed (${planA.buildSteps.length} → ${planB.buildSteps.length} steps)`,
      });
    }
  }

  private static assessImpact(
    field: string,
    _oldValue: any,
    _newValue: any
  ): "low" | "medium" | "high" {
    if (field === "framework" || field === "architecture") {
      return "high";
    }
    if (field === "pythonVersion") {
      return "medium";
    }
    return "low";
  }

  private static assessDependencyImpact(dep: any): "low" | "medium" | "high" {
    const criticalDeps = ["torch", "tensorflow", "numpy", "scikit-learn"];
    return criticalDeps.some((critical) =>
      dep.name.toLowerCase().includes(critical.toLowerCase())
    )
      ? "high"
      : "medium";
  }

  private static assessVersionChangeImpact(
    oldVersion: string,
    newVersion: string
  ): "low" | "medium" | "high" {
    // Simple semantic version impact assessment
    const oldParts = oldVersion.replace(/[^0-9.]/g, "").split(".");
    const newParts = newVersion.replace(/[^0-9.]/g, "").split(".");

    if (oldParts[0] !== newParts[0]) {
      return "high"; // Major version change
    }
    if (oldParts[1] !== newParts[1]) {
      return "medium"; // Minor version change
    }
    return "low"; // Patch version change
  }

  private static assessModelChangeImpact(
    prop: string,
    _oldValue: any,
    _newValue: any
  ): "low" | "medium" | "high" {
    if (prop === "architecture" || prop === "totalParameters") {
      return "high";
    }
    if (prop === "inputShape" || prop === "outputShape") {
      return "medium";
    }
    return "low";
  }

  private static assessResourceChangeImpact(
    _prop: string,
    oldValue: any,
    newValue: any
  ): "low" | "medium" | "high" {
    if (typeof oldValue !== "number" || typeof newValue !== "number") {
      return "medium";
    }

    const change = Math.abs((newValue - oldValue) / oldValue);
    if (change > 0.5) {
      return "high"; // 50%+ change
    }
    if (change > 0.2) {
      return "medium"; // 20%+ change
    }
    return "low";
  }

  private static generateSummary(
    differences: PlanDiff[]
  ): PlanComparison["summary"] {
    const categoryCounts: Record<string, number> = {};
    let highImpactChanges = 0;

    for (const diff of differences) {
      categoryCounts[diff.category] = (categoryCounts[diff.category] || 0) + 1;
      if (diff.impact === "high") {
        highImpactChanges++;
      }
    }

    return {
      totalChanges: differences.length,
      highImpactChanges,
      categoryCounts,
    };
  }

  static formatComparison(
    comparison: PlanComparison,
    useColors = true
  ): string {
    const colorize = (text: string, colorFn: (text: string) => string) =>
      useColors ? colorFn(text) : text;
    const lines: string[] = [];

    // Header
    lines.push(colorize("Plan Comparison", chalk.bold.blue));
    lines.push(
      colorize(
        `  Plan A: ${comparison.planA.command} (${new Date(comparison.planA.timestamp).toLocaleString()})`,
        chalk.gray
      )
    );
    lines.push(
      colorize(
        `  Plan B: ${comparison.planB.command} (${new Date(comparison.planB.timestamp).toLocaleString()})`,
        chalk.gray
      )
    );
    lines.push("");

    // Summary
    lines.push(colorize("Summary:", chalk.bold.yellow));
    lines.push(
      colorize(
        `  • Total changes: ${comparison.summary.totalChanges}`,
        chalk.cyan
      )
    );
    lines.push(
      colorize(
        `  • High impact changes: ${comparison.summary.highImpactChanges}`,
        comparison.summary.highImpactChanges > 0 ? chalk.red : chalk.green
      )
    );

    // Category breakdown
    if (Object.keys(comparison.summary.categoryCounts).length > 0) {
      lines.push("  • Changes by category:");
      for (const [category, count] of Object.entries(
        comparison.summary.categoryCounts
      )) {
        lines.push(colorize(`    - ${category}: ${count}`, chalk.gray));
      }
    }
    lines.push("");

    // Detailed changes
    if (comparison.differences.length > 0) {
      lines.push(colorize("Detailed Changes:", chalk.bold.magenta));

      // Group by category
      const byCategory: Record<string, PlanDiff[]> = {};
      for (const diff of comparison.differences) {
        if (!byCategory[diff.category]) {
          byCategory[diff.category] = [];
        }
        byCategory[diff.category]?.push(diff);
      }

      for (const [category, diffs] of Object.entries(byCategory)) {
        lines.push(
          colorize(
            `  ${PlanDiffAnalyzer.getCategoryIcon(category)} ${category.toUpperCase()}:`,
            chalk.bold
          )
        );

        for (const diff of diffs) {
          const impactColor =
            diff.impact === "high"
              ? chalk.red
              : diff.impact === "medium"
                ? chalk.yellow
                : chalk.green;
          const typeIcon =
            diff.type === "added" ? "+" : diff.type === "removed" ? "-" : "~";

          lines.push(
            colorize(
              `    ${typeIcon} [${diff.impact.toUpperCase()}] ${diff.description}`,
              impactColor
            )
          );
        }
        lines.push("");
      }
    } else {
      lines.push(colorize("No differences found", chalk.green));
    }

    return lines.join("\n");
  }

  private static getCategoryIcon(category: string): string {
    const labels: Record<string, string> = {
      dependencies: "[deps]",
      artifacts: "[artifacts]",
      model: "[model]",
      resources: "[resources]",
      config: "[config]",
    };
    return labels[category] || "[other]";
  }

  private static formatBytes(bytes: number): string {
    if (bytes === 0) {
      return "0 B";
    }

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));

    const value = bytes / k ** i;
    const sign = bytes >= 0 ? "+" : "";

    return `${sign}${value.toFixed(1)} ${sizes[i]}`;
  }
}
