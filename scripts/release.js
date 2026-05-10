#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const semver = require("semver");

const packageJsonPath = path.join(import.meta.dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

function log(message) {
  console.log(`[RELEASE] ${message}`);
}

function error(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

function exec(command, options = {}) {
  log(`Running: ${command}`);
  try {
    return execSync(command, {
      stdio: options.silent ? "pipe" : "inherit",
      encoding: "utf8",
      ...options,
    });
  } catch {
    error(`Command failed: ${command}`);
  }
}

function checkGitStatus() {
  log("Checking git status...");

  const status = exec("git status --porcelain", { silent: true }).trim();
  if (status) {
    error("Working directory is not clean. Please commit or stash changes.");
  }

  const branch = exec("git branch --show-current", { silent: true }).trim();
  if (branch !== "main" && branch !== "master") {
    error(`Not on main/master branch. Current branch: ${branch}`);
  }

  log("Git status is clean");
}

function getNextVersion(current, increment) {
  const next = semver.inc(current, increment);
  if (!next) {
    error(`Invalid version increment: ${increment}`);
  }
  return next;
}

function updateVersion(newVersion) {
  log(`Updating version to ${newVersion}...`);

  packageJson.version = newVersion;
  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`
  );

  // Update other version references if needed
  const readmePath = path.join(import.meta.dirname, "..", "README.md");
  if (fs.existsSync(readmePath)) {
    let readme = fs.readFileSync(readmePath, "utf8");
    // Update any version references in README
    readme = readme.replace(/cirron-cli@[\d.]+/g, `cirron-cli@${newVersion}`);
    fs.writeFileSync(readmePath, readme);
  }
}

function runTests() {
  log("Running tests...");
  exec("npm test");
  log("Tests passed");
}

function buildProject() {
  log("Building project...");
  exec("npm run build");
  log("Build completed");
}

function buildBinaries() {
  log("Building binaries...");
  exec("npm run build:all");
  log("Binaries built");
}

function createGitTag(version) {
  log(`Creating git tag v${version}...`);
  exec("git add .");
  exec(`git commit -m "Release v${version}"`);
  exec(`git tag v${version}`);
  log(`Tag v${version} created`);
}

function pushToGit() {
  log("Pushing to git...");
  exec("git push origin main --tags");
  log("Pushed to git");
}

function generateChangelog(version) {
  log("Generating changelog...");

  const changelogPath = path.join(import.meta.dirname, "..", "CHANGELOG.md");
  const date = new Date().toISOString().split("T")[0];

  let changelog = "";
  if (fs.existsSync(changelogPath)) {
    changelog = fs.readFileSync(changelogPath, "utf8");
  } else {
    changelog =
      "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n";
  }

  const newEntry = `## [${version}] - ${date}\n\n### Added\n- New features go here\n\n### Changed\n- Changes go here\n\n### Fixed\n- Bug fixes go here\n\n`;

  // Insert after the header
  const lines = changelog.split("\n");
  const insertIndex = lines.findIndex((line) => line.startsWith("## ")) || 3;
  lines.splice(insertIndex, 0, newEntry);

  fs.writeFileSync(changelogPath, lines.join("\n"));
  log("Changelog template created");
}

function showInstructions(version) {
  console.log(`\n${"=".repeat(50)}`);
  console.log("Release process completed!");
  console.log("=".repeat(50));
  console.log();
  console.log(`Version: ${version}`);
  console.log(`Tag: v${version}`);
  console.log();
  console.log("Next steps:");
  console.log("1. The git tag has been pushed to trigger GitHub Actions");
  console.log("2. Check GitHub Actions for build status");
  console.log("3. Update the changelog with actual changes");
  console.log("4. Monitor NPM publication");
  console.log("5. Test the published package:");
  console.log(`   npm install -g cirron-cli@${version}`);
  console.log();
  console.log("GitHub Release will be created automatically with binaries.");
  console.log();
}

function main() {
  const args = process.argv.slice(2);
  const increment = args[0] || "patch"; // patch, minor, major

  if (!["patch", "minor", "major"].includes(increment)) {
    error("Invalid increment. Use: patch, minor, or major");
  }

  const currentVersion = packageJson.version;
  const newVersion = getNextVersion(currentVersion, increment);

  console.log(`Current version: ${currentVersion}`);
  console.log(`New version: ${newVersion}`);
  console.log(`Increment: ${increment}`);
  console.log();

  // Confirm with user
  const readline = require("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("Continue with release? (y/N) ", (answer) => {
    rl.close();

    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      log("Release cancelled");
      process.exit(0);
    }

    try {
      checkGitStatus();
      runTests();
      updateVersion(newVersion);
      buildProject();
      buildBinaries();
      generateChangelog(newVersion);
      createGitTag(newVersion);
      pushToGit();
      showInstructions(newVersion);
    } catch (err) {
      error(`Release failed: ${err.message}`);
    }
  });
}

if (require.main === module) {
  main();
}
