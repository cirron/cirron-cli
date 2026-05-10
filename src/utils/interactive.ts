import chalk from "chalk";
import inquirer from "inquirer";
import { logger } from "./logger";

export interface InteractiveOptions {
  choices?: string[] | { name: string; value: any }[];
  default?: boolean;
  description?: string;
  estimatedTime?: string;
  impact?: "low" | "medium" | "high";
  message: string;
  type?: "confirm" | "select" | "input";
}

export interface StepConfirmationOptions {
  default?: boolean;
  dependencies?: string[];
  description: string;
  estimatedTime?: string;
  impact?: "low" | "medium" | "high";
  stepName: string;
}

export class InteractiveManager {
  private continueAll = false;
  private readonly interactive: boolean;

  constructor(isInteractive = false) {
    this.interactive = isInteractive;
  }

  /**
   * Ask for confirmation before executing a step
   */
  async confirmStep(options: StepConfirmationOptions): Promise<boolean> {
    // Skip prompts if not in interactive mode
    if (!this.interactive) {
      return true;
    }

    // Skip prompts if user chose "Continue All"
    if (this.continueAll) {
      return true;
    }

    // Display step information
    console.log(`\n${chalk.bold.blue(`${options.stepName}`)}`);
    console.log(chalk.gray(`   ${options.description}`));

    if (options.estimatedTime) {
      console.log(chalk.gray(`   Estimated time: ${options.estimatedTime}`));
    }

    if (options.impact) {
      const impactColor =
        options.impact === "high"
          ? chalk.red
          : options.impact === "medium"
            ? chalk.yellow
            : chalk.green;
      console.log(chalk.gray(`   Impact: ${impactColor(options.impact)}`));
    }

    if (options.dependencies && options.dependencies.length > 0) {
      console.log(
        chalk.gray(`   Dependencies: ${options.dependencies.join(", ")}`)
      );
    }

    const choices = [
      { name: "Yes", value: "yes" },
      { name: "No", value: "no" },
      { name: "Continue All (skip remaining prompts)", value: "continue-all" },
    ];

    const { action } = await inquirer.prompt([
      {
        type: "select",
        name: "action",
        message: `Proceed with ${options.stepName}?`,
        choices,
        default: options.default === false ? "no" : "yes",
        loop: false, // Prevent infinite carousel - stop at top and bottom
      },
    ]);

    if (action === "continue-all") {
      this.continueAll = true;
      logger.info(chalk.blue("Continuing with all remaining steps..."));
      return true;
    }

    return action === "yes";
  }

  /**
   * Present multiple options to the user
   */
  async selectOption(options: InteractiveOptions): Promise<any> {
    if (!this.interactive) {
      // Return first choice or default if not interactive
      if (options.choices && options.choices.length > 0) {
        const firstChoice = options.choices[0];
        return typeof firstChoice === "object"
          ? firstChoice.value
          : firstChoice;
      }
      return true;
    }

    if (options.description) {
      console.log(`\n${chalk.gray(options.description)}`);
    }

    const promptConfig: any = {
      type: options.type || "select",
      name: "selection",
      message: options.message,
    };

    if (options.choices) {
      promptConfig.choices = options.choices;
    }

    if (options.default !== undefined) {
      promptConfig.default = options.default;
    }

    // Add loop: false for select prompts to prevent infinite carousel
    if (options.type === "select") {
      promptConfig.loop = false;
    }

    const { selection } = await inquirer.prompt([promptConfig]);
    return selection;
  }

  /**
   * Get user input for a value
   */
  async getInput(
    message: string,
    defaultValue?: string,
    description?: string
  ): Promise<string> {
    if (!this.interactive) {
      return defaultValue || "";
    }

    if (description) {
      console.log(`\n${chalk.gray(description)}`);
    }

    const { input } = await inquirer.prompt([
      {
        type: "input",
        name: "input",
        message,
        default: defaultValue,
      },
    ]);

    return input;
  }

  /**
   * Confirm a potentially destructive or resource-intensive operation
   */
  async confirmCriticalOperation(
    operationName: string,
    details: string[],
    warning?: string
  ): Promise<boolean> {
    if (!this.interactive) {
      return true;
    }

    console.log(`\n${chalk.bold.yellow(`${operationName}`)}`);

    if (details.length > 0) {
      console.log(chalk.gray("This operation will:"));
      for (const detail of details) {
        console.log(chalk.gray(`  • ${detail}`));
      }
    }

    if (warning) {
      console.log(`\n${chalk.red(`Warning: ${warning}`)}`);
    }

    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: `Are you sure you want to proceed with ${operationName}?`,
        default: false,
      },
    ]);

    return confirmed;
  }

  /**
   * Allow user to select which steps to run from a list
   */
  async selectSteps(
    availableSteps: { name: string; description: string; default?: boolean }[],
    _message = "Which steps would you like to run?"
  ): Promise<string[]> {
    if (!this.interactive) {
      // Return all steps that are default true, or all if none specified
      const defaultSteps = availableSteps.filter(
        (step) => step.default !== false
      );
      return defaultSteps.length > 0
        ? defaultSteps.map((s) => s.name)
        : availableSteps.map((s) => s.name);
    }

    // First, let the user choose a preset or custom selection
    const { selectionType } = await inquirer.prompt([
      {
        type: "select",
        name: "selectionType",
        message: "How would you like to select steps?",
        choices: [
          { name: "All steps", value: "all" },
          { name: "Essential only (quick)", value: "essential" },
          { name: "Custom selection", value: "custom" },
          { name: "None (skip all)", value: "none" },
        ],
        loop: false, // Prevent infinite carousel - stop at top and bottom
      },
    ]);

    // Handle preset selections
    if (selectionType === "all") {
      return availableSteps.map((s) => s.name);
    }

    if (selectionType === "none") {
      return [];
    }

    if (selectionType === "essential") {
      // Return essential steps (those marked as default or critical)
      return availableSteps
        .filter((step) => step.default !== false)
        .map((s) => s.name);
    }

    // Custom selection - show individual checkboxes
    const { selectedSteps } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selectedSteps",
        message: "Select individual steps to run:",
        choices: availableSteps.map((step) => ({
          name: `${step.name} - ${step.description}`,
          value: step.name,
          checked: step.default !== false,
        })),
        loop: false, // Prevent infinite carousel - stop at top and bottom
        validate: (input) =>
          input.length > 0 ? true : "Please select at least one step",
      },
    ]);

    return selectedSteps;
  }

  /**
   * Display progress and ask for confirmation to continue
   */
  async showProgressAndConfirm(
    completedSteps: string[],
    currentStep: string,
    remainingSteps: string[],
    error?: string
  ): Promise<boolean> {
    if (!this.interactive) {
      return true;
    }

    console.log(`\n${chalk.bold.blue("Progress Update")}`);

    // Show completed steps
    if (completedSteps.length > 0) {
      console.log(chalk.green("Completed:"));
      for (const step of completedSteps) {
        console.log(chalk.green(`  ✓ ${step}`));
      }
    }

    // Show current step
    if (error) {
      console.log(chalk.red(`Failed: ${currentStep}`));
      console.log(chalk.red(`   Error: ${error}`));
    } else {
      console.log(chalk.blue(`Current: ${currentStep}`));
    }

    // Show remaining steps
    if (remainingSteps.length > 0) {
      console.log(chalk.gray("Remaining:"));
      for (const step of remainingSteps) {
        console.log(chalk.gray(`  ○ ${step}`));
      }
    }

    if (error) {
      const { action } = await inquirer.prompt([
        {
          type: "select",
          name: "action",
          message: "How would you like to proceed?",
          choices: [
            { name: "Continue with remaining steps", value: "continue" },
            { name: "Retry current step", value: "retry" },
            { name: "Abort operation", value: "abort" },
          ],
          loop: false, // Prevent infinite carousel - stop at top and bottom
        },
      ]);

      return action !== "abort";
    }
    const { shouldContinue } = await inquirer.prompt([
      {
        type: "confirm",
        name: "shouldContinue",
        message: "Continue with remaining steps?",
        default: true,
      },
    ]);

    return shouldContinue;
  }

  /**
   * Reset the continue all state
   */
  resetContinueAll(): void {
    this.continueAll = false;
  }

  /**
   * Check if in interactive mode
   */
  isInteractive(): boolean {
    return this.interactive;
  }

  /**
   * Check if user chose continue all
   */
  isContinueAll(): boolean {
    return this.continueAll;
  }
}

/**
 * Helper function to create a new interactive manager
 */
export function createInteractiveManager(
  isInteractive: boolean
): InteractiveManager {
  return new InteractiveManager(isInteractive);
}

/**
 * Quick helper for simple confirmations
 */
export async function simpleConfirm(
  message: string,
  defaultValue = true,
  isInteractive = false
): Promise<boolean> {
  if (!isInteractive) {
    return defaultValue;
  }

  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message,
      default: defaultValue,
    },
  ]);

  return confirmed;
}
