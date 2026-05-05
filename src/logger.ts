import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logDir = join(__dirname, '..', 'logs');
const logFile = join(logDir, 'proxy.log');

try { mkdirSync(logDir, { recursive: true }); } catch {}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function formatTime(): string {
  return new Date().toISOString();
}

function writeLine(level: string, args: unknown[]): void {
  try {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ');
    appendFileSync(logFile, `[${formatTime()}] [${level}] ${msg}\n`);
  } catch {}
}

console.log = (...args: unknown[]) => {
  writeLine('INFO', args);
  originalLog.apply(console, args);
};

console.error = (...args: unknown[]) => {
  writeLine('ERROR', args);
  originalError.apply(console, args);
};

console.warn = (...args: unknown[]) => {
  writeLine('WARN', args);
  originalWarn.apply(console, args);
};

export function getLogFilePath(): string {
  return logFile;
}
