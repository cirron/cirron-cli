import fs from "fs-extra";
import { minimatch } from "minimatch";
import path from "path";

export interface IgnoreOptions {
  cwd?: string;
  defaultPatterns?: string[];
  ignoreFile?: string;
}

export class CirronIgnore {
  private patterns: string[] = [];
  private cwd: string;
  private ignoreFilePath: string;

  constructor(options: IgnoreOptions = {}) {
    this.cwd = options.cwd || process.cwd();
    this.ignoreFilePath =
      options.ignoreFile || path.join(this.cwd, ".cirronignore");
    this.patterns = options.defaultPatterns || [];

    this.loadIgnoreFile();
  }

  private loadIgnoreFile(): void {
    try {
      if (fs.existsSync(this.ignoreFilePath)) {
        const content = fs.readFileSync(this.ignoreFilePath, "utf8");
        const filePatterns = this.parseIgnoreFile(content);
        this.patterns = [...this.patterns, ...filePatterns];
      }
    } catch (error) {
      // Silently ignore file read errors
    }
  }

  private parseIgnoreFile(content: string): string[] {
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")) // Remove empty lines and comments
      .map((line) => {
        // Handle negation patterns (starting with !)
        if (line.startsWith("!")) {
          return line;
        }

        // Normalize directory patterns
        if (line.endsWith("/")) {
          return line + "**";
        }

        return line;
      });
  }

  public isIgnored(filePath: string): boolean {
    const relativePath = path.relative(
      this.cwd,
      path.resolve(this.cwd, filePath)
    );

    // Normalize path separators for cross-platform compatibility
    const normalizedPath = relativePath.replace(/\\/g, "/");

    let ignored = false;

    for (const pattern of this.patterns) {
      if (pattern.startsWith("!")) {
        // Negation pattern - if it matches, file is NOT ignored
        const negationPattern = pattern.substring(1);
        if (this.matchPattern(normalizedPath, negationPattern)) {
          ignored = false;
        }
      } else {
        // Regular pattern - if it matches, file is ignored
        if (this.matchPattern(normalizedPath, pattern)) {
          ignored = true;
        }
      }
    }

    return ignored;
  }

  private matchPattern(filePath: string, pattern: string): boolean {
    // Handle directory patterns
    if (pattern.endsWith("/**")) {
      const dirPattern = pattern.slice(0, -3);
      if (filePath.startsWith(dirPattern + "/") || filePath === dirPattern) {
        return true;
      }
    }

    // Use minimatch for glob pattern matching
    return minimatch(filePath, pattern, {
      dot: true, // Match files starting with .
      matchBase: true, // Match basename against pattern
    });
  }

  public filterFiles(files: string[]): string[] {
    return files.filter((file) => !this.isIgnored(file));
  }

  public addPattern(pattern: string): void {
    this.patterns.push(pattern);
  }

  public getPatterns(): string[] {
    return [...this.patterns];
  }

  public static createDefault(cwd?: string): CirronIgnore {
    const defaultPatterns = [
      // Version control
      ".git/**",
      ".svn/**",
      ".hg/**",

      // Dependencies
      "node_modules/**",
      "__pycache__/**",
      "*.pyc",
      ".pytest_cache/**",
      "venv/**",
      "env/**",
      ".env",

      // Build artifacts
      "dist/**",
      "build/**",
      "*.log",
      "*.tmp",
      "*.temp",

      // IDE files
      ".vscode/**",
      ".idea/**",
      "*.swp",
      "*.swo",
      "*~",

      // OS files
      ".DS_Store",
      "Thumbs.db",

      // Cirron specific
      "temp_*.py",
      "temp_*.sh",
    ];

    return new CirronIgnore({
      cwd: cwd || process.cwd(),
      defaultPatterns,
    });
  }

  public reload(): void {
    this.patterns = [];
    this.loadIgnoreFile();
  }
}

export function createIgnoreFilter(
  options?: IgnoreOptions
): (filePath: string) => boolean {
  const ignore = new CirronIgnore(options);
  return (filePath: string) => !ignore.isIgnored(filePath);
}

export function filterIgnoredFiles(
  files: string[],
  options?: IgnoreOptions
): string[] {
  const ignore = new CirronIgnore(options);
  return ignore.filterFiles(files);
}
