import chalk from "chalk";
import type { ArtifactPlan, DependencyInfo, PlanFile } from "./plan";

export interface FormatOptions {
  compact: boolean;
  showDetails: boolean;
  useColors: boolean;
}

export class PlanFormatter {
  static formatConsole(
    plan: PlanFile,
    options: FormatOptions = {
      useColors: true,
      showDetails: false,
      compact: false,
    }
  ): string {
    const { useColors, showDetails, compact } = options;
    const colorize = (text: string, colorFn: (text: string) => string) =>
      useColors ? colorFn(text) : text;

    const sections: string[] = [];

    // Header
    sections.push(colorize("Build Plan Summary:", chalk.bold.blue));
    sections.push(colorize(`  • Command: ${plan.command}`, chalk.gray));
    sections.push(colorize(`  • Target: ${plan.architecture}`, chalk.cyan));
    sections.push(colorize(`  • Framework: ${plan.framework}`, chalk.green));
    sections.push(colorize(`  • Python: ${plan.pythonVersion}`, chalk.yellow));
    sections.push(
      colorize(
        `  • Generated: ${new Date(plan.timestamp).toLocaleString()}`,
        chalk.gray
      )
    );

    if (!compact) {
      sections.push("");

      // Planned Artifacts
      sections.push(colorize(" Planned Artifacts:", chalk.bold.yellow));
      if (plan.artifacts.length > 0) {
        for (const artifact of plan.artifacts) {
          const sizeStr = PlanFormatter.formatBytes(artifact.estimatedSize);
          const icon = PlanFormatter.getArtifactIcon(artifact.type);
          sections.push(
            colorize(`  ${icon} ${artifact.path}`, chalk.cyan) +
              colorize(` (${sizeStr})`, chalk.gray)
          );
          if (showDetails && artifact.description) {
            sections.push(
              colorize(`     └─ ${artifact.description}`, chalk.gray)
            );
          }
        }

        const totalArtifactSize = plan.artifacts.reduce(
          (sum, a) => sum + a.estimatedSize,
          0
        );
        sections.push(
          colorize(
            `  └─ Total artifacts: ${PlanFormatter.formatBytes(totalArtifactSize)}`,
            chalk.bold
          )
        );
      } else {
        sections.push(colorize("  └─ No artifacts planned", chalk.gray));
      }

      sections.push("");

      // Dependencies
      sections.push(colorize("Dependencies:", chalk.bold.magenta));
      if (plan.dependencies.length > 0) {
        const categorized = PlanFormatter.categorizeDependencies(
          plan.dependencies
        );

        for (const [category, deps] of Object.entries(categorized)) {
          if (deps.length > 0) {
            const categoryIcon = PlanFormatter.getCategoryIcon(category);
            const categoryName = PlanFormatter.getCategoryName(category);
            sections.push(
              colorize(
                `  ${categoryIcon} ${categoryName} (${deps.length} packages):`,
                chalk.bold
              )
            );

            for (const dep of deps) {
              const sizeStr = PlanFormatter.formatBytes(dep.estimatedSize);
              const sizeColor = PlanFormatter.getSizeColor(
                dep.estimatedSize,
                useColors
              );
              sections.push(
                colorize(`     • ${dep.name}${dep.version}`, chalk.green) +
                  colorize(` (~${sizeStr})`, sizeColor)
              );

              // Show size warnings inline
              if (dep.estimatedSize >= 500 * 1024 * 1024) {
                // 500MB+
                sections.push(
                  colorize(
                    "       Very large package - consider alternatives",
                    chalk.yellow
                  )
                );
              } else if (dep.estimatedSize >= 100 * 1024 * 1024) {
                // 100MB+
                sections.push(colorize("       Large package", chalk.yellow));
              }

              if (showDetails && dep.conflicts && dep.conflicts.length > 0) {
                sections.push(
                  colorize(
                    `       Potential conflicts: ${dep.conflicts.join(", ")}`,
                    chalk.yellow
                  )
                );
              }
            }
          }
        }

        const totalDepSize = plan.dependencies.reduce(
          (sum, dep) => sum + dep.estimatedSize,
          0
        );
        sections.push(
          colorize(
            `  └─ Total estimated size: ${PlanFormatter.formatBytes(totalDepSize)}`,
            chalk.bold
          )
        );
      } else {
        sections.push(colorize("  └─ No dependencies found", chalk.gray));
      }

      sections.push("");

      // Model Shape Analysis
      if (plan.modelShape) {
        sections.push(colorize("Model Analysis:", chalk.bold.green));
        sections.push(
          colorize(
            `  • Architecture: ${plan.modelShape.architecture}`,
            chalk.cyan
          )
        );
        sections.push(
          colorize(
            `  • Parameters: ${PlanFormatter.formatNumber(plan.modelShape.totalParameters)}`,
            chalk.yellow
          ) +
            colorize(
              ` (trainable: ${PlanFormatter.formatNumber(plan.modelShape.trainableParameters)})`,
              chalk.gray
            )
        );
        sections.push(
          colorize(
            `  • Estimated memory: ${PlanFormatter.formatBytes(plan.modelShape.estimatedMemory)}`,
            chalk.red
          )
        );

        if (plan.modelShape.inputShape) {
          sections.push(
            colorize(
              `  • Input shape: ${plan.modelShape.inputShape}`,
              chalk.blue
            )
          );
        }
        if (plan.modelShape.outputShape) {
          sections.push(
            colorize(
              `  • Output shape: ${plan.modelShape.outputShape}`,
              chalk.blue
            )
          );
        }

        // Layer breakdown if available and showDetails is true
        if (
          showDetails &&
          plan.modelShape.layers &&
          plan.modelShape.layers.length > 0
        ) {
          sections.push(colorize("  • Layer breakdown:", chalk.gray));
          for (const layer of plan.modelShape.layers.slice(0, 5)) {
            // Show first 5 layers
            const paramStr = layer.parameters
              ? PlanFormatter.formatNumber(layer.parameters)
              : "?";
            sections.push(
              colorize(
                `     └─ ${layer.name} (${layer.type}): ${paramStr} params`,
                chalk.gray
              )
            );
          }
          if (plan.modelShape.layers.length > 5) {
            sections.push(
              colorize(
                `     └─ ... and ${plan.modelShape.layers.length - 5} more layers`,
                chalk.gray
              )
            );
          }
        }
      } else {
        sections.push(colorize("Model Analysis:", chalk.bold.green));
        sections.push(
          colorize(
            "  └─ Model analysis not available (run after model creation)",
            chalk.gray
          )
        );
      }

      sections.push("");

      // Resource Estimates
      sections.push(colorize("Resource Estimates:", chalk.bold.red));
      sections.push(
        colorize(
          `  • Disk space: ${PlanFormatter.formatBytes(plan.resources.diskSpace)}`,
          chalk.cyan
        )
      );
      sections.push(
        colorize(
          `  • Memory: ${PlanFormatter.formatBytes(plan.resources.memory)}`,
          chalk.yellow
        )
      );

      // Enhanced time estimation
      const resources = plan.resources as any;
      if (resources.estimatedTimeRange && resources.baseline) {
        const { min, max } = resources.estimatedTimeRange;
        const timeStr = `${min}–${max} sec (based on ${resources.baseline} baseline`;
        const depStr = resources.totalDependencySize
          ? ` + ${PlanFormatter.formatBytes(resources.totalDependencySize)} deps`
          : "";
        sections.push(
          colorize(`  • Estimated time: ${timeStr}${depStr})`, chalk.green)
        );
      } else {
        sections.push(
          colorize(
            `  • Estimated time: ${PlanFormatter.formatDuration(plan.resources.estimatedTime)}`,
            chalk.green
          )
        );
      }

      if (plan.resources.gpuMemory) {
        sections.push(
          colorize(
            `  • GPU memory: ${PlanFormatter.formatBytes(plan.resources.gpuMemory)}`,
            chalk.magenta
          )
        );
      }

      // Build Steps
      if (showDetails) {
        sections.push("");
        sections.push(colorize(" Build Steps:", chalk.bold.blue));
        for (let i = 0; i < plan.buildSteps.length; i++) {
          const step = plan.buildSteps[i];
          sections.push(colorize(`  ${i + 1}. ${step}`, chalk.blue));
        }
      }

      // Warnings
      if (plan.warnings && plan.warnings.length > 0) {
        sections.push("");
        sections.push(colorize("Warnings:", chalk.bold.yellow));
        for (const warning of plan.warnings) {
          sections.push(colorize(`  • ${warning}`, chalk.yellow));
        }
      }
    }

    return sections.join("\n");
  }

  static formatJSON(plan: PlanFile, pretty = true): string {
    if (pretty) {
      return JSON.stringify(plan, null, 2);
    }
    return JSON.stringify(plan);
  }

  static formatSummaryLine(plan: PlanFile): string {
    const totalArtifacts = plan.artifacts.length;
    const totalDeps = plan.dependencies.length;
    const totalParams = plan.modelShape?.totalParameters || 0;
    const totalSize = plan.resources.diskSpace;

    return `${plan.framework} ${plan.architecture} - ${totalArtifacts} artifacts, ${totalDeps} deps, ${PlanFormatter.formatNumber(totalParams)} params, ${PlanFormatter.formatBytes(totalSize)}`;
  }

  private static formatBytes(bytes: number): string {
    if (bytes === 0) {
      return "0 B";
    }

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    const value = bytes / k ** i;
    const formatted = i === 0 ? value.toString() : value.toFixed(1);

    return `${formatted} ${sizes[i]}`;
  }

  private static formatNumber(num: number): string {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
  }

  private static formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return remainingSeconds > 0
        ? `${minutes}m ${remainingSeconds}s`
        : `${minutes}m`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  private static getArtifactIcon(type: ArtifactPlan["type"]): string {
    const labels = {
      model: "[model]",
      metadata: "[meta]",
      config: "[config]",
      checkpoint: "[ckpt]",
    };
    return labels[type] || "[artifact]";
  }

  private static getCategoryIcon(category: string): string {
    const labels: Record<string, string> = {
      "ml-framework": "[ml]",
      "data-processing": "[data]",
      utility: "[util]",
      development: "[dev]",
    };
    return labels[category] || "[other]";
  }

  private static getCategoryName(category: string): string {
    const names: Record<string, string> = {
      "ml-framework": "ML Frameworks",
      "data-processing": "Data Processing",
      utility: "Utilities",
      development: "Development",
    };
    return names[category] || "Other";
  }

  private static categorizeDependencies(
    dependencies: DependencyInfo[]
  ): Record<string, DependencyInfo[]> {
    const categorized: Record<string, DependencyInfo[]> = {
      "ml-framework": [],
      "data-processing": [],
      utility: [],
      development: [],
    };

    for (const dep of dependencies) {
      if (dep && dep.category) {
        const category = dep.category as keyof typeof categorized;
        if (categorized[category]) {
          categorized[category].push(dep);
        }
      }
    }

    return categorized;
  }

  private static getSizeColor(
    size: number,
    useColors: boolean
  ): (text: string) => string {
    if (!useColors) {
      return (text: string) => text;
    }

    if (size >= 500 * 1024 * 1024) {
      // 500MB+
      return chalk.red;
    }
    if (size >= 100 * 1024 * 1024) {
      // 100MB+
      return chalk.yellow;
    }
    return chalk.gray;
  }

  // Export plan to file
  static async exportPlanFile(
    plan: PlanFile,
    filePath: string,
    format: "json" | "yaml" = "json"
  ): Promise<void> {
    const fs = await import("fs-extra");

    if (format === "json") {
      await fs.writeFile(filePath, PlanFormatter.formatJSON(plan, true));
    } else if (format === "yaml") {
      // YAML export not currently supported - fallback to JSON
      const fallbackPath = filePath.replace(/\.ya?ml$/, ".json");
      await fs.writeFile(fallbackPath, PlanFormatter.formatJSON(plan, true));
    }
  }

  // Create a compact summary for CI/CD logs
  static formatCIOutput(plan: PlanFile): string {
    const lines = [
      `::notice title=Build Plan::${PlanFormatter.formatSummaryLine(plan)}`,
      `::group::Artifacts (${plan.artifacts.length})`,
    ];

    for (const artifact of plan.artifacts) {
      lines.push(
        `${artifact.path} (${PlanFormatter.formatBytes(artifact.estimatedSize)})`
      );
    }

    lines.push("::endgroup::");

    if (plan.dependencies && plan.dependencies.length > 0) {
      lines.push(`::group::Dependencies (${plan.dependencies.length})`);
      const totalDepSize = plan.dependencies.reduce(
        (sum, dep) => sum + dep.estimatedSize,
        0
      );
      lines.push(`Total size: ${PlanFormatter.formatBytes(totalDepSize)}`);
      lines.push("::endgroup::");
    }

    if (plan.modelShape) {
      lines.push(
        `::notice title=Model::${plan.modelShape.architecture} - ${PlanFormatter.formatNumber(plan.modelShape.totalParameters)} parameters`
      );
    }

    if (plan.warnings && plan.warnings.length > 0) {
      for (const warning of plan.warnings) {
        lines.push(`::warning::${warning}`);
      }
    }

    return lines.join("\n");
  }
}
