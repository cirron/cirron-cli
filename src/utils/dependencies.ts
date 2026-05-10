import fs from "fs-extra";

export interface DependencySpec {
  name: string;
  operator: string; // '==', '>=', '<=', '>', '<', '~=', '!='
  version: string;
}

export interface ParsedDependency {
  environment?: string; // Environment marker like python_version >= "3.8"
  extras?: string[]; // e.g., ['gpu'] for tensorflow[gpu]
  name: string;
  specs: DependencySpec[];
}

export interface DependencyAnalysis {
  categorizedDeps: {
    "ml-framework": ParsedDependency[];
    "data-processing": ParsedDependency[];
    utility: ParsedDependency[];
    development: ParsedDependency[];
  };
  conflicts: DependencyConflict[];
  dependencies: ParsedDependency[];
  recommendations: string[];
  totalEstimatedSize: number;
}

export interface DependencyConflict {
  affectedPackages: string[];
  message: string;
  severity: "warning" | "error";
  suggestion?: string;
  type: "version" | "compatibility" | "redundancy";
}

export class DependencyParser {
  private static readonly PACKAGE_SIZES: Record<string, number> = {
    // ML Frameworks (in bytes)
    torch: 800 * 1024 * 1024,
    pytorch: 800 * 1024 * 1024,
    tensorflow: 500 * 1024 * 1024,
    "tensorflow-gpu": 600 * 1024 * 1024,
    keras: 50 * 1024 * 1024,
    "scikit-learn": 25 * 1024 * 1024,
    sklearn: 25 * 1024 * 1024,
    xgboost: 15 * 1024 * 1024,
    lightgbm: 10 * 1024 * 1024,
    catboost: 20 * 1024 * 1024,
    transformers: 100 * 1024 * 1024,

    // Data Processing
    numpy: 15 * 1024 * 1024,
    pandas: 40 * 1024 * 1024,
    scipy: 30 * 1024 * 1024,
    matplotlib: 30 * 1024 * 1024,
    seaborn: 5 * 1024 * 1024,
    plotly: 25 * 1024 * 1024,
    pillow: 3 * 1024 * 1024,
    "opencv-python": 50 * 1024 * 1024,
    imageio: 5 * 1024 * 1024,

    // Utilities
    requests: 500 * 1024,
    urllib3: 200 * 1024,
    tqdm: 100 * 1024,
    click: 300 * 1024,
    pyyaml: 200 * 1024,
    "python-dateutil": 200 * 1024,
    pytz: 500 * 1024,
    joblib: 1024 * 1024,

    // Development
    pytest: 2 * 1024 * 1024,
    black: 1024 * 1024,
    flake8: 500 * 1024,
    mypy: 3 * 1024 * 1024,
    jupyter: 10 * 1024 * 1024,
    ipython: 5 * 1024 * 1024,
  };

  private static readonly CATEGORY_KEYWORDS = {
    "ml-framework": [
      "torch",
      "pytorch",
      "tensorflow",
      "keras",
      "scikit-learn",
      "sklearn",
      "xgboost",
      "lightgbm",
      "catboost",
      "transformers",
      "huggingface",
    ],
    "data-processing": [
      "numpy",
      "pandas",
      "scipy",
      "matplotlib",
      "seaborn",
      "plotly",
      "pillow",
      "opencv",
      "imageio",
      "skimage",
      "cv2",
    ],
    utility: [
      "requests",
      "urllib3",
      "tqdm",
      "click",
      "pyyaml",
      "dateutil",
      "pytz",
      "joblib",
      "pickle",
      "json",
      "csv",
    ],
    development: [
      "pytest",
      "unittest",
      "black",
      "flake8",
      "mypy",
      "pylint",
      "jupyter",
      "ipython",
      "notebook",
    ],
  };

  static async parseRequirements(
    requirementsPath: string
  ): Promise<DependencyAnalysis> {
    if (!fs.existsSync(requirementsPath)) {
      return {
        dependencies: [],
        totalEstimatedSize: 0,
        conflicts: [],
        recommendations: ["Create requirements.txt with project dependencies"],
        categorizedDeps: {
          "ml-framework": [],
          "data-processing": [],
          utility: [],
          development: [],
        },
      };
    }

    const content = await fs.readFile(requirementsPath, "utf8");
    const dependencies = DependencyParser.parseRequirementsContent(content);

    return {
      dependencies,
      totalEstimatedSize: DependencyParser.calculateTotalSize(dependencies),
      conflicts: DependencyParser.detectConflicts(dependencies),
      recommendations: DependencyParser.generateRecommendations(dependencies),
      categorizedDeps: DependencyParser.categorizeDependencies(dependencies),
    };
  }

  private static parseRequirementsContent(content: string): ParsedDependency[] {
    const dependencies: ParsedDependency[] = [];

    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"));

    for (const line of lines) {
      const parsed = DependencyParser.parseDependencyLine(line);
      if (parsed) {
        dependencies.push(parsed);
      }
    }

    return dependencies;
  }

  private static parseDependencyLine(line: string): ParsedDependency | null {
    // Remove environment markers first
    const envMarkerMatch = line.match(/^(.+?)\s*;\s*(.+)$/);
    const environment = envMarkerMatch ? envMarkerMatch[2] : undefined;
    const cleanLine = envMarkerMatch ? envMarkerMatch[1] : line;

    if (!cleanLine) {
      return null;
    }

    // Parse extras like tensorflow[gpu]
    const extrasMatch = cleanLine.match(/^([^[]+)\[([^\]]+)\](.*)$/);
    const packageName = extrasMatch
      ? extrasMatch[1]
      : cleanLine.split(/[<>=!~]/)[0];
    const extras =
      extrasMatch && extrasMatch[2]
        ? extrasMatch[2].split(",").map((e) => e.trim())
        : undefined;
    const versionPart = extrasMatch
      ? extrasMatch[3]
      : cleanLine.slice(packageName?.length || 0);

    if (!packageName) {
      return null;
    }

    // Parse version specifications
    const specs = DependencyParser.parseVersionSpecs(versionPart || "");

    const result: ParsedDependency = {
      name: packageName.trim(),
      specs,
    };

    if (extras) {
      result.extras = extras;
    }

    if (environment) {
      result.environment = environment;
    }

    return result;
  }

  private static parseVersionSpecs(versionPart: string): DependencySpec[] {
    const specs: DependencySpec[] = [];

    // Split on commas to handle multiple specs like ">=1.21.0,<1.26.0"
    const specStrings = versionPart
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s);

    for (const specString of specStrings) {
      const match = specString.match(/^([<>=!~]+)(.+)$/);
      if (match && match[1] && match[2]) {
        specs.push({
          name: "",
          operator: match[1],
          version: match[2].trim(),
        });
      } else if (specString && !specString.match(/^[<>=!~]/)) {
        // Exact version specification
        specs.push({
          name: "",
          operator: "==",
          version: specString,
        });
      }
    }

    return specs;
  }

  private static calculateTotalSize(dependencies: ParsedDependency[]): number {
    let totalSize = 0;

    for (const dep of dependencies) {
      totalSize += DependencyParser.estimatePackageSize(dep.name);
    }

    return totalSize;
  }

  private static estimatePackageSize(packageName: string): number {
    const lowerName = packageName.toLowerCase();

    // Direct match
    if (DependencyParser.PACKAGE_SIZES[lowerName]) {
      return DependencyParser.PACKAGE_SIZES[lowerName];
    }

    // Partial match
    for (const [knownPackage, size] of Object.entries(
      DependencyParser.PACKAGE_SIZES
    )) {
      if (
        lowerName.includes(knownPackage) ||
        knownPackage.includes(lowerName)
      ) {
        return size;
      }
    }

    // Default size for unknown packages
    return 1024 * 1024; // 1MB
  }

  private static detectConflicts(
    dependencies: ParsedDependency[]
  ): DependencyConflict[] {
    const conflicts: DependencyConflict[] = [];
    const packageNames = dependencies.map((d) => d.name.toLowerCase());

    // Check for common conflicts
    DependencyParser.checkFrameworkConflicts(packageNames, conflicts);
    DependencyParser.checkVersionConflicts(dependencies, conflicts);
    DependencyParser.checkRedundantPackages(packageNames, conflicts);

    return conflicts;
  }

  private static checkFrameworkConflicts(
    packageNames: string[],
    conflicts: DependencyConflict[]
  ): void {
    const hasTorch = packageNames.some(
      (name) => name.includes("torch") || name.includes("pytorch")
    );
    const hasTensorFlow = packageNames.some((name) =>
      name.includes("tensorflow")
    );

    if (hasTorch && hasTensorFlow) {
      conflicts.push({
        type: "compatibility",
        severity: "warning",
        message:
          "PyTorch and TensorFlow in same environment may cause conflicts",
        affectedPackages: ["torch", "tensorflow"],
        suggestion:
          "Consider using separate environments for different ML frameworks",
      });
    }

    // Check for GPU variants
    const hasRegularTF = packageNames.includes("tensorflow");
    const hasGpuTF = packageNames.some(
      (name) =>
        name.includes("tensorflow-gpu") || name.includes("tensorflow[gpu]")
    );

    if (hasRegularTF && hasGpuTF) {
      conflicts.push({
        type: "redundancy",
        severity: "error",
        message: "Both tensorflow and tensorflow-gpu/tensorflow[gpu] specified",
        affectedPackages: ["tensorflow"],
        suggestion:
          "Use only tensorflow[gpu] for GPU support in modern versions",
      });
    }
  }

  private static checkVersionConflicts(
    dependencies: ParsedDependency[],
    conflicts: DependencyConflict[]
  ): void {
    const numpyDep = dependencies.find((d) => d.name.toLowerCase() === "numpy");
    const tensorflowDep = dependencies.find((d) =>
      d.name.toLowerCase().includes("tensorflow")
    );

    if (numpyDep && tensorflowDep) {
      // Check for numpy version constraints that might conflict with TensorFlow
      const hasUpperBound = numpyDep.specs.some(
        (spec) => spec.operator.includes("<") && spec.version.startsWith("1.26")
      );

      if (hasUpperBound) {
        conflicts.push({
          type: "version",
          severity: "warning",
          message:
            "NumPy version constraint may conflict with newer TensorFlow versions",
          affectedPackages: ["numpy", "tensorflow"],
          suggestion: "Consider updating NumPy version constraints",
        });
      }
    }
  }

  private static checkRedundantPackages(
    packageNames: string[],
    conflicts: DependencyConflict[]
  ): void {
    const redundancies = [
      { packages: ["scikit-learn", "sklearn"], primary: "scikit-learn" },
      { packages: ["pillow", "pil"], primary: "pillow" },
      { packages: ["opencv-python", "cv2"], primary: "opencv-python" },
    ];

    for (const redundancy of redundancies) {
      const foundPackages = redundancy.packages.filter((pkg) =>
        packageNames.some((name) => name.includes(pkg))
      );

      if (foundPackages.length > 1) {
        conflicts.push({
          type: "redundancy",
          severity: "warning",
          message: `Multiple variants of the same package: ${foundPackages.join(", ")}`,
          affectedPackages: foundPackages,
          suggestion: `Use only ${redundancy.primary}`,
        });
      }
    }
  }

  private static generateRecommendations(
    dependencies: ParsedDependency[]
  ): string[] {
    const recommendations: string[] = [];
    const packageNames = dependencies.map((d) => d.name.toLowerCase());

    // Missing common dependencies
    if (
      packageNames.some((name) => name.includes("torch")) &&
      !packageNames.includes("torchvision")
    ) {
      recommendations.push(
        "Consider adding torchvision for PyTorch image processing"
      );
    }

    if (
      packageNames.some((name) => name.includes("tensorflow")) &&
      !packageNames.includes("pillow")
    ) {
      recommendations.push(
        "Consider adding Pillow for TensorFlow image preprocessing"
      );
    }

    if (
      packageNames.some((name) => name.includes("pandas")) &&
      !packageNames.includes("numpy")
    ) {
      recommendations.push(
        "Pandas requires NumPy - consider adding explicit numpy dependency"
      );
    }

    // Version pinning recommendations
    const unpinnedCritical = dependencies.filter(
      (d) =>
        ["torch", "tensorflow", "numpy"].some((critical) =>
          d.name.toLowerCase().includes(critical)
        ) && d.specs.length === 0
    );

    if (unpinnedCritical.length > 0) {
      recommendations.push(
        `Pin versions for critical packages: ${unpinnedCritical.map((d) => d.name).join(", ")}`
      );
    }

    // Size optimization
    const totalSize = DependencyParser.calculateTotalSize(dependencies);
    if (totalSize > 2 * 1024 * 1024 * 1024) {
      // 2GB
      recommendations.push(
        "Dependencies are quite large - consider using lighter alternatives or Docker layers"
      );
    }

    return recommendations;
  }

  private static categorizeDependencies(
    dependencies: ParsedDependency[]
  ): DependencyAnalysis["categorizedDeps"] {
    const categorized: DependencyAnalysis["categorizedDeps"] = {
      "ml-framework": [],
      "data-processing": [],
      utility: [],
      development: [],
    };

    for (const dep of dependencies) {
      const category = DependencyParser.categorizePackage(dep.name);
      categorized[category].push(dep);
    }

    return categorized;
  }

  private static categorizePackage(
    packageName: string
  ): keyof DependencyAnalysis["categorizedDeps"] {
    const lowerName = packageName.toLowerCase();

    for (const [category, keywords] of Object.entries(
      DependencyParser.CATEGORY_KEYWORDS
    )) {
      if (keywords.some((keyword) => lowerName.includes(keyword))) {
        return category as keyof DependencyAnalysis["categorizedDeps"];
      }
    }

    return "utility";
  }

  static formatSize(bytes: number): string {
    if (bytes === 0) {
      return "0 B";
    }

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
  }
}
