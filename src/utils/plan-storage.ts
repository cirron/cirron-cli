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
}