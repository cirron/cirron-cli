import chalk from "chalk";

export class Logger {
  private verbose: boolean;

  constructor() {
    this.verbose = process.env["CIRRON_VERBOSE"] === "true";
  }

  info(message: string, ...args: any[]): void {
    console.log(message, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(chalk.red("Error:"), message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(chalk.yellow("Warning:"), message, ...args);
  }

  success(message: string, ...args: any[]): void {
    console.log(chalk.green("Success:"), message, ...args);
  }

  debug(message: string, ...args: any[]): void {
    if (this.verbose) {
      console.log(chalk.gray("Debug:"), message, ...args);
    }
  }

  table(data: any[]): void {
    console.table(data);
  }

  json(data: any): void {
    console.log(JSON.stringify(data, null, 2));
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }
}

export const logger = new Logger();
