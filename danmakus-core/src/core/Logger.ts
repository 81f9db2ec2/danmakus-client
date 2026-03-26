import { LogLevel } from '../types';

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50
};

type LogMethod = 'debug' | 'info' | 'warn' | 'error';

interface LoggerState {
  level: LogLevel;
}

export function normalizeLogLevel(level: unknown, fallback: LogLevel = 'info'): LogLevel {
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error' || level === 'silent') {
    return level;
  }
  return fallback;
}

export class ScopedLogger {
  private state: LoggerState;

  constructor(
    private scope: string,
    level: LogLevel = 'info',
    state?: LoggerState
  ) {
    this.state = state ?? { level: normalizeLogLevel(level) };
  }

  child(scope: string): ScopedLogger {
    const nextScope = this.scope ? `${this.scope}/${scope}` : scope;
    return new ScopedLogger(nextScope, this.state.level, this.state);
  }

  setLevel(level: LogLevel): void {
    this.state.level = normalizeLogLevel(level, this.state.level);
  }

  getLevel(): LogLevel {
    return this.state.level;
  }

  debug(...args: unknown[]): void {
    this.write('debug', args);
  }

  info(...args: unknown[]): void {
    this.write('info', args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', args);
  }

  error(...args: unknown[]): void {
    this.write('error', args);
  }

  private write(method: LogMethod, args: unknown[]): void {
    if (!this.shouldLog(method)) {
      return;
    }

    const prefix = this.scope ? `[${this.scope}]` : '';

    if (method === 'debug') {
      console.log(prefix, ...args);
      return;
    }
    if (method === 'info') {
      console.log(prefix, ...args);
      return;
    }
    if (method === 'warn') {
      console.warn(prefix, ...args);
      return;
    }
    console.error(prefix, ...args);
  }

  private shouldLog(method: LogMethod): boolean {
    const currentWeight = LOG_LEVEL_WEIGHT[this.state.level];
    const targetWeight = LOG_LEVEL_WEIGHT[method];
    return targetWeight >= currentWeight;
  }
}
