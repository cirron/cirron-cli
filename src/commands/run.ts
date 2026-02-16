import { logger } from '../utils/logger';

export async function runPipelineCommand(_nameOrId: string | undefined, _options: Record<string, unknown>): Promise<void> {
  logger.info('This command is not yet implemented.');
}

export async function runJobCommand(_options: Record<string, unknown>): Promise<void> {
  logger.info('This command is not yet implemented.');
}

export async function runInferenceCommand(_deployment: string | undefined, _options: Record<string, unknown>): Promise<void> {
  logger.info('This command is not yet implemented.');
}

export async function runSweepCommand(_options: Record<string, unknown>): Promise<void> {
  logger.info('This command is not yet implemented.');
}

export async function runListCommand(_options: Record<string, unknown>): Promise<void> {
  logger.info('This command is not yet implemented.');
}

export async function runStatusCommand(_runId: string, _options: Record<string, unknown>): Promise<void> {
  logger.info('This command is not yet implemented.');
}

export async function runCancelCommand(_runId: string, _options: Record<string, unknown>): Promise<void> {
  logger.info('This command is not yet implemented.');
}

export async function runLogsCommand(_runId: string, _options: Record<string, unknown>): Promise<void> {
  logger.info('This command is not yet implemented.');
}
