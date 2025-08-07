import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { logger } from './logger';
import type { PlanFile } from './plan';
import type { SavedPlan } from '../types';

export class PlanStorage {
  private static readonly PLANS_DIR = path.join(os.homedir(), '.cirron', 'plans');
  
  static async ensurePlanDirectory(): Promise<void> {
    await fs.ensureDir(this.PLANS_DIR);
  }

  static async savePlan(
    plan: PlanFile, 
    options: {
      filename?: string;
      description?: string;
      tags?: string[];
    } = {}
  ): Promise<string> {
    await this.ensurePlanDirectory();
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = options.filename || `plan-${plan.command}-${timestamp}.json`;
    const filePath = path.join(this.PLANS_DIR, filename);
    
    const metadata: SavedPlan['metadata'] = {
      savedAt: new Date().toISOString(),
      savedBy: os.userInfo().username
    };
    
    if (options.description) {
      metadata.description = options.description;
    }
    
    if (options.tags) {
      metadata.tags = options.tags;
    }
    
    const savedPlan: SavedPlan = {
      filePath,
      plan,
      metadata
    };
    
    await fs.writeJson(filePath, savedPlan, { spaces: 2 });
    
    logger.info(`Plan saved to: ${filePath}`);
    return filePath;
  }

  static async loadPlan(filePath: string): Promise<SavedPlan> {
    if (!fs.existsSync(filePath)) {
      // Try to find it in plans directory if not absolute path
      if (!path.isAbsolute(filePath)) {
        const fullPath = path.join(this.PLANS_DIR, filePath);
        if (fs.existsSync(fullPath)) {
          filePath = fullPath;
        } else {
          throw new Error(`Plan file not found: ${filePath}`);
        }
      } else {
        throw new Error(`Plan file not found: ${filePath}`);
      }
    }
    
    try {
      const savedPlan = await fs.readJson(filePath) as SavedPlan;
      return savedPlan;
    } catch (error) {
      throw new Error(`Failed to load plan file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  static async listPlans(): Promise<SavedPlan[]> {
    await this.ensurePlanDirectory();
    
    const files = await fs.readdir(this.PLANS_DIR);
    const planFiles = files.filter(file => file.endsWith('.json'));
    
    const plans: SavedPlan[] = [];
    
    for (const file of planFiles) {
      try {
        const filePath = path.join(this.PLANS_DIR, file);
        const savedPlan = await this.loadPlan(filePath);
        plans.push(savedPlan);
      } catch (error) {
        logger.debug(`Failed to load plan ${file}:`, error);
      }
    }
    
    // Sort by creation time, newest first
    plans.sort((a, b) => new Date(b.metadata.savedAt).getTime() - new Date(a.metadata.savedAt).getTime());
    
    return plans;
  }

  static async deletePlan(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      if (!path.isAbsolute(filePath)) {
        const fullPath = path.join(this.PLANS_DIR, filePath);
        if (fs.existsSync(fullPath)) {
          filePath = fullPath;
        } else {
          throw new Error(`Plan file not found: ${filePath}`);
        }
      } else {
        throw new Error(`Plan file not found: ${filePath}`);
      }
    }
    
    await fs.remove(filePath);
    logger.info(`Plan deleted: ${filePath}`);
  }

  static async cleanupOldPlans(maxAge: number = 30): Promise<number> {
    await this.ensurePlanDirectory();
    
    const plans = await this.listPlans();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAge);
    
    let deletedCount = 0;
    
    for (const savedPlan of plans) {
      const planDate = new Date(savedPlan.metadata.savedAt);
      if (planDate < cutoffDate) {
        try {
          await this.deletePlan(savedPlan.filePath);
          deletedCount++;
        } catch (error) {
          logger.debug(`Failed to delete old plan ${savedPlan.filePath}:`, error);
        }
      }
    }
    
    return deletedCount;
  }

  static validatePlan(savedPlan: SavedPlan): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!savedPlan.plan) {
      errors.push('Missing plan data');
    }
    
    if (!savedPlan.metadata) {
      errors.push('Missing plan metadata');
    }
    
    if (savedPlan.plan) {
      if (!savedPlan.plan.command) {
        errors.push('Plan missing command');
      }
      
      if (!savedPlan.plan.framework) {
        errors.push('Plan missing framework');
      }
      
      if (!savedPlan.plan.timestamp) {
        errors.push('Plan missing timestamp');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  static generatePlanFilename(plan: PlanFile, suffix?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const parts = [
      'plan',
      plan.command,
      plan.framework,
      plan.architecture,
      timestamp
    ];
    
    if (suffix) {
      parts.push(suffix);
    }
    
    return parts.join('-') + '.json';
  }

  static async saveBatchPlans(
    plans: { plan: PlanFile; filename?: string; description?: string; tags?: string[] }[],
    globalOptions: { description?: string; tags?: string[] } = {}
  ): Promise<string[]> {
    await this.ensurePlanDirectory();
    
    const savedPaths: string[] = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    for (const { plan, filename, description, tags } of plans) {
      const mergedOptions: {
        filename?: string;
        description?: string;
        tags?: string[];
      } = {
        filename: filename || `batch-${plan.command}-${timestamp}`
      };
      
      const finalDescription = description || globalOptions.description;
      if (finalDescription) {
        mergedOptions.description = finalDescription;
      }
      
      const finalTags = tags || globalOptions.tags;
      if (finalTags) {
        mergedOptions.tags = finalTags;
      }
      
      try {
        const savedPath = await this.savePlan(plan, mergedOptions);
        savedPaths.push(savedPath);
      } catch (error) {
        // Log error but continue with other plans
        console.warn(`Failed to save ${plan.command} plan:`, error instanceof Error ? error.message : String(error));
      }
    }
    
    return savedPaths;
  }

  static async findPlansByPattern(pattern: {
    command?: string;
    framework?: string;
    architecture?: string;
    dateRange?: { start: Date; end: Date };
    tags?: string[];
  }): Promise<SavedPlan[]> {
    const allPlans = await this.listPlans();
    
    return allPlans.filter(savedPlan => {
      const plan = savedPlan.plan;
      const metadata = savedPlan.metadata;
      
      // Filter by command
      if (pattern.command && plan.command !== pattern.command) {
        return false;
      }
      
      // Filter by framework
      if (pattern.framework && plan.framework !== pattern.framework) {
        return false;
      }
      
      // Filter by architecture
      if (pattern.architecture && plan.architecture !== pattern.architecture) {
        return false;
      }
      
      // Filter by date range
      if (pattern.dateRange) {
        const savedAt = new Date(metadata.savedAt);
        if (savedAt < pattern.dateRange.start || savedAt > pattern.dateRange.end) {
          return false;
        }
      }
      
      // Filter by tags
      if (pattern.tags && pattern.tags.length > 0) {
        const planTags = metadata.tags || [];
        const hasAnyTag = pattern.tags.some(tag => planTags.includes(tag));
        if (!hasAnyTag) {
          return false;
        }
      }
      
      return true;
    });
  }

  static async getStorageStats(): Promise<{
    totalPlans: number;
    totalSize: number;
    oldestPlan?: Date;
    newestPlan?: Date;
    plansByCommand: Record<string, number>;
    plansByFramework: Record<string, number>;
  }> {
    await this.ensurePlanDirectory();
    
    const plans = await this.listPlans();
    const stats: {
      totalPlans: number;
      totalSize: number;
      oldestPlan?: Date;
      newestPlan?: Date;
      plansByCommand: Record<string, number>;
      plansByFramework: Record<string, number>;
    } = {
      totalPlans: plans.length,
      totalSize: 0,
      plansByCommand: {} as Record<string, number>,
      plansByFramework: {} as Record<string, number>
    };
    
    if (plans.length === 0) {
      return stats;
    }
    
    // Calculate file sizes and dates
    for (const savedPlan of plans) {
      try {
        const stat = await require('fs-extra').stat(savedPlan.filePath);
        stats.totalSize += stat.size;
      } catch (error) {
        // File might not exist, skip size calculation
      }
      
      const savedAt = new Date(savedPlan.metadata.savedAt);
      if (!stats.oldestPlan || savedAt < stats.oldestPlan) {
        stats.oldestPlan = savedAt;
      }
      if (!stats.newestPlan || savedAt > stats.newestPlan) {
        stats.newestPlan = savedAt;
      }
      
      // Count by command
      const command = savedPlan.plan.command;
      stats.plansByCommand[command] = (stats.plansByCommand[command] || 0) + 1;
      
      // Count by framework
      const framework = savedPlan.plan.framework;
      stats.plansByFramework[framework] = (stats.plansByFramework[framework] || 0) + 1;
    }
    
    return stats;
  }

  static async exportPlansArchive(outputPath: string, options: {
    includePattern?: { command?: string; framework?: string; dateRange?: { start: Date; end: Date } };
    format?: 'zip' | 'tar';
  } = {}): Promise<void> {
    const plans = options.includePattern 
      ? await this.findPlansByPattern(options.includePattern)
      : await this.listPlans();
    
    if (plans.length === 0) {
      throw new Error('No plans found to export');
    }
    
    // For now, just create a JSON export with all plans
    // In a real implementation, you might use archiver or similar
    const exportData = {
      exportedAt: new Date().toISOString(),
      totalPlans: plans.length,
      plans: plans.map(savedPlan => ({
        plan: savedPlan.plan,
        metadata: savedPlan.metadata
      }))
    };
    
    const fs = await import('fs-extra');
    await fs.writeJson(outputPath, exportData, { spaces: 2 });
  }
}