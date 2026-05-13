import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CirronIgnore } from "../../../src/utils/ignore";
import { makeTmpDir } from "../../helpers/tmpdir";

describe("CirronIgnore", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-ignore-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  function writeIgnoreFile(contents: string): void {
    fs.writeFileSync(path.join(tmp.dir, ".cirronignore"), contents);
  }

  describe("pattern matching", () => {
    it("matches literal file names", () => {
      writeIgnoreFile("secret.txt\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored("secret.txt")).toBe(true);
      expect(ig.isIgnored("public.txt")).toBe(false);
    });

    it("matches glob wildcards", () => {
      writeIgnoreFile("*.log\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored("app.log")).toBe(true);
      expect(ig.isIgnored("error.log")).toBe(true);
      expect(ig.isIgnored("app.txt")).toBe(false);
    });

    it("matches directory patterns with trailing slash", () => {
      writeIgnoreFile("build/\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored("build/output.js")).toBe(true);
      expect(ig.isIgnored("build/nested/deep.js")).toBe(true);
      expect(ig.isIgnored("src/build.js")).toBe(false);
    });

    it("matches deep glob (**)", () => {
      writeIgnoreFile("**/*.pyc\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored("foo.pyc")).toBe(true);
      expect(ig.isIgnored("nested/deep/foo.pyc")).toBe(true);
    });

    it("ignores dotfiles by default", () => {
      writeIgnoreFile(".env\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored(".env")).toBe(true);
    });
  });

  describe("negation patterns (!)", () => {
    it("re-includes a file matched by an earlier ignore rule", () => {
      writeIgnoreFile("*.log\n!important.log\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored("app.log")).toBe(true);
      expect(ig.isIgnored("important.log")).toBe(false);
    });

    it("respects ordering — last matching rule wins", () => {
      writeIgnoreFile("data/\n!data/sample.csv\ndata/sample.csv\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      // Final ignore overrides the negation
      expect(ig.isIgnored("data/sample.csv")).toBe(true);
    });
  });

  describe("file parsing", () => {
    it("skips comment lines starting with #", () => {
      writeIgnoreFile("# this is a comment\n*.log\n# another\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored("app.log")).toBe(true);
      expect(ig.getPatterns()).toEqual(["*.log"]);
    });

    it("skips empty lines", () => {
      writeIgnoreFile("\n*.log\n\n\n*.tmp\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.getPatterns()).toEqual(["*.log", "*.tmp"]);
    });

    it("works when no .cirronignore exists (no-op)", () => {
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored("anything.txt")).toBe(false);
      expect(ig.getPatterns()).toEqual([]);
    });
  });

  describe("default patterns", () => {
    it("createDefault() ignores common ML/Python noise", () => {
      const ig = CirronIgnore.createDefault(tmp.dir);
      expect(ig.isIgnored("node_modules/foo/index.js")).toBe(true);
      expect(ig.isIgnored("__pycache__/foo.pyc")).toBe(true);
      expect(ig.isIgnored(".git/HEAD")).toBe(true);
      expect(ig.isIgnored("dist/bundle.js")).toBe(true);
      expect(ig.isIgnored(".DS_Store")).toBe(true);
    });

    it("createDefault() does not ignore project source by default", () => {
      const ig = CirronIgnore.createDefault(tmp.dir);
      expect(ig.isIgnored("src/main.py")).toBe(false);
      expect(ig.isIgnored("cirron.json")).toBe(false);
      expect(ig.isIgnored("model.py")).toBe(false);
    });
  });

  describe("filterFiles()", () => {
    it("returns only files not ignored", () => {
      writeIgnoreFile("*.log\n");
      const ig = new CirronIgnore({ cwd: tmp.dir });
      const result = ig.filterFiles(["main.py", "app.log", "config.json"]);
      expect(result).toEqual(["main.py", "config.json"]);
    });
  });

  describe("addPattern() and reload()", () => {
    it("addPattern adds to in-memory patterns", () => {
      const ig = new CirronIgnore({ cwd: tmp.dir });
      ig.addPattern("*.tmp");
      expect(ig.isIgnored("scratch.tmp")).toBe(true);
    });

    it("reload re-reads the ignore file from disk", () => {
      const ig = new CirronIgnore({ cwd: tmp.dir });
      expect(ig.isIgnored("new.log")).toBe(false);

      writeIgnoreFile("*.log\n");
      ig.reload();
      expect(ig.isIgnored("new.log")).toBe(true);
    });
  });
});
