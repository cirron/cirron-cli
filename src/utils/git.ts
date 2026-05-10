import { execSync } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";
import { logger } from "./logger";

export interface GitInfo {
  branch?: string;
  commitHash?: string;
  isClean?: boolean;
  lastCommitDate?: string;
  lastCommitMessage?: string;
  remoteOrigin?: string;
}

/**
 * Check if the current directory is a git repository
 */
export function isGitRepository(workingDir: string = process.cwd()): boolean {
  try {
    const gitDir = path.join(workingDir, ".git");
    return fs.existsSync(gitDir);
  } catch {
    return false;
  }
}

/**
 * Get the current git commit hash
 */
export function getCurrentCommitHash(
  workingDir: string = process.cwd()
): string | null {
  try {
    if (!isGitRepository(workingDir)) {
      return null;
    }

    const result = execSync("git rev-parse HEAD", {
      cwd: workingDir,
      stdio: "pipe",
      encoding: "utf8",
    });

    return result.trim();
  } catch (error) {
    logger.debug("Failed to get git commit hash:", error);
    return null;
  }
}

/**
 * Get the current git branch name
 */
export function getCurrentBranch(
  workingDir: string = process.cwd()
): string | null {
  try {
    if (!isGitRepository(workingDir)) {
      return null;
    }

    const result = execSync("git branch --show-current", {
      cwd: workingDir,
      stdio: "pipe",
      encoding: "utf8",
    });

    return result.trim() || null;
  } catch (error) {
    logger.debug("Failed to get git branch:", error);
    return null;
  }
}

/**
 * Get the remote origin URL
 */
export function getRemoteOrigin(
  workingDir: string = process.cwd()
): string | null {
  try {
    if (!isGitRepository(workingDir)) {
      return null;
    }

    const result = execSync("git config --get remote.origin.url", {
      cwd: workingDir,
      stdio: "pipe",
      encoding: "utf8",
    });

    return result.trim() || null;
  } catch (error) {
    logger.debug("Failed to get git remote origin:", error);
    return null;
  }
}

/**
 * Check if the working directory is clean (no uncommitted changes)
 */
export function isWorkingDirectoryClean(
  workingDir: string = process.cwd()
): boolean {
  try {
    if (!isGitRepository(workingDir)) {
      return true; // No git repo means "clean" in this context
    }

    const result = execSync("git status --porcelain", {
      cwd: workingDir,
      stdio: "pipe",
      encoding: "utf8",
    });

    return result.trim() === "";
  } catch (error) {
    logger.debug("Failed to check git working directory status:", error);
    return false;
  }
}

/**
 * Get the last commit message
 */
export function getLastCommitMessage(
  workingDir: string = process.cwd()
): string | null {
  try {
    if (!isGitRepository(workingDir)) {
      return null;
    }

    const result = execSync("git log -1 --pretty=%B", {
      cwd: workingDir,
      stdio: "pipe",
      encoding: "utf8",
    });

    return result.trim() || null;
  } catch (error) {
    logger.debug("Failed to get git commit message:", error);
    return null;
  }
}

/**
 * Get the last commit date
 */
export function getLastCommitDate(
  workingDir: string = process.cwd()
): string | null {
  try {
    if (!isGitRepository(workingDir)) {
      return null;
    }

    const result = execSync("git log -1 --pretty=%ci", {
      cwd: workingDir,
      stdio: "pipe",
      encoding: "utf8",
    });

    return result.trim() || null;
  } catch (error) {
    logger.debug("Failed to get git commit date:", error);
    return null;
  }
}

/**
 * Get comprehensive git repository information
 */
export function getRepositoryInfo(workingDir: string = process.cwd()): GitInfo {
  if (!isGitRepository(workingDir)) {
    return {};
  }

  const info: GitInfo = {
    isClean: isWorkingDirectoryClean(workingDir),
  };

  const commitHash = getCurrentCommitHash(workingDir);
  if (commitHash) {
    info.commitHash = commitHash;
  }

  const branch = getCurrentBranch(workingDir);
  if (branch) {
    info.branch = branch;
  }

  const remoteOrigin = getRemoteOrigin(workingDir);
  if (remoteOrigin) {
    info.remoteOrigin = remoteOrigin;
  }

  const lastCommitMessage = getLastCommitMessage(workingDir);
  if (lastCommitMessage) {
    info.lastCommitMessage = lastCommitMessage;
  }

  const lastCommitDate = getLastCommitDate(workingDir);
  if (lastCommitDate) {
    info.lastCommitDate = lastCommitDate;
  }

  return info;
}

/**
 * Get a short version of the commit hash (first 7 characters)
 */
export function getShortCommitHash(
  workingDir: string = process.cwd()
): string | null {
  const fullHash = getCurrentCommitHash(workingDir);
  return fullHash ? fullHash.substring(0, 7) : null;
}
