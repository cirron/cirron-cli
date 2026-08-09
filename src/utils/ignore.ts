import path from "node:path";
import fs from "fs-extra";
import { minimatch } from "minimatch";

export interface IgnoreOptions {
  cwd?: string;
  defaultPatterns?: string[];
  ignoreFile?: string;
}

/**
 * `.cirronignore` matching, in the style of `.gitignore` and `.dockerignore`.
 *
 * Patterns are globs evaluated by minimatch. A leading `!` re-includes a path
 * an earlier pattern excluded, and a trailing `/` is expanded to `/**` so a
 * directory entry covers its contents. Blank lines and `#` comments are
 * skipped. A missing or unreadable ignore file is not an error — it just
 * leaves the pattern set as it was.
 *
 * **The constructor applies no patterns of its own.** `options.defaultPatterns`
 * defaults to empty, so `new CirronIgnore()` in a project with no
 * `.cirronignore` ignores nothing at all, and a caller scanning a directory
 * will happily pick up `node_modules` or a stray `.env`. Use
 * `CirronIgnore.createDefault()` unless you specifically want that.
 */
export class CirronIgnore {
  private patterns: string[] = [];
  private readonly cwd: string;
  private readonly ignoreFilePath: string;

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
    } catch {
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
          return `${line}**`;
        }

        return line;
      });
  }

  /**
   * Whether a path matches any active pattern.
   *
   * Negation wins: a later `!pattern` re-includes a path an earlier pattern
   * excluded. Matching is `dot: true` and `matchBase: true`, so dotfiles are
   * considered and a bare pattern matches on basename anywhere in the tree.
   *
   * @param filePath - Absolute or cwd-relative path.
   * @returns True when the path should be excluded.
   */
  isIgnored(filePath: string): boolean {
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
        const negationPattern = pattern.slice(1);
        if (this.matchPattern(normalizedPath, negationPattern)) {
          ignored = false;
        }
      } else if (this.matchPattern(normalizedPath, pattern)) {
        // Regular pattern - if it matches, file is ignored
        ignored = true;
      }
    }

    return ignored;
  }

  private matchPattern(filePath: string, pattern: string): boolean {
    // Handle directory patterns
    if (pattern.endsWith("/**")) {
      const dirPattern = pattern.slice(0, -3);
      if (filePath.startsWith(`${dirPattern}/`) || filePath === dirPattern) {
        return true;
      }
    }

    // Use minimatch for glob pattern matching
    return minimatch(filePath, pattern, {
      dot: true, // Match files starting with .
      matchBase: true, // Match basename against pattern
    });
  }

  /**
   * Drop every ignored path from a list.
   *
   * @param files - Paths to filter.
   * @returns The paths that are not ignored.
   */
  filterFiles(files: string[]): string[] {
    return files.filter((file) => !this.isIgnored(file));
  }

  /**
   * Append one pattern to the active set.
   *
   * Not normalized the way file-loaded patterns are — a trailing `/` is not
   * expanded to `/**` here.
   *
   * @param pattern - A glob, or `!glob` to re-include.
   */
  addPattern(pattern: string): void {
    this.patterns.push(pattern);
  }

  /**
   * The active patterns, in precedence order.
   *
   * @returns A copy, so mutating it does not affect this instance.
   */
  getPatterns(): string[] {
    return [...this.patterns];
  }

  /**
   * An instance seeded with sensible exclusions for an ML project.
   *
   * Covers version control, dependency and virtualenv directories, build
   * output, IDE and OS junk, and the CLI's own `temp_*` scratch files. Any
   * `.cirronignore` found is layered on top.
   *
   * Prefer this over `new CirronIgnore()`, which starts with no patterns at
   * all — see the class note.
   *
   * @param cwd - Directory to resolve against; defaults to `process.cwd()`.
   * @returns The seeded instance.
   */
  static createDefault(cwd?: string): CirronIgnore {
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

  /**
   * Re-read `.cirronignore` from disk.
   *
   * Clears the pattern list first, which also discards any `defaultPatterns`
   * passed to the constructor — reloading an instance built by
   * `createDefault()` leaves it with only the file's patterns.
   */
  reload(): void {
    this.patterns = [];
    this.loadIgnoreFile();
  }
}

/**
 * A predicate that passes paths which are NOT ignored.
 *
 * Note the inversion: this returns true for files to keep, so it can be handed
 * straight to `Array.prototype.filter`.
 *
 * @param options - Forwarded to the CirronIgnore constructor.
 * @returns A keep-this-file predicate.
 */
export function createIgnoreFilter(
  options?: IgnoreOptions
): (filePath: string) => boolean {
  const ignore = new CirronIgnore(options);
  return (filePath: string) => !ignore.isIgnored(filePath);
}

/**
 * Drop ignored paths from a list, without keeping the instance around.
 *
 * @param files - Paths to filter.
 * @param options - Forwarded to the CirronIgnore constructor.
 * @returns The paths that are not ignored.
 */
export function filterIgnoredFiles(
  files: string[],
  options?: IgnoreOptions
): string[] {
  const ignore = new CirronIgnore(options);
  return ignore.filterFiles(files);
}
