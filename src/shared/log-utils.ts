import { readdirSync, existsSync } from 'fs';
import { loadLogs, RequestLogRecord, LOGS_PATH } from '../db.js';

/**
 * 获取所有日志
 */
export function getAllLogs(): RequestLogRecord[] {
  if (!existsSync(LOGS_PATH)) return [];
  const files = readdirSync(LOGS_PATH).filter((f: string) => f.endsWith('.json')).sort();
  const allLogs: RequestLogRecord[] = [];
  for (const file of files) {
    const date = file.replace('.json', '');
    allLogs.push(...loadLogs(date));
  }
  return allLogs;
}

/**
 * 按日期范围获取日志
 */
export function getLogsByDateRange(startDate: string, endDate: string): RequestLogRecord[] {
  if (!existsSync(LOGS_PATH)) return [];
  const files = readdirSync(LOGS_PATH).filter((f: string) => f.endsWith('.json')).sort();
  const allLogs: RequestLogRecord[] = [];
  for (const file of files) {
    const date = file.replace('.json', '');
    if (date >= startDate && date <= endDate) {
      allLogs.push(...loadLogs(date));
    }
  }
  return allLogs;
}

/**
 * 按账号ID获取日志
 */
export function getLogsByAccountId(accountId: string): RequestLogRecord[] {
  const allLogs = getAllLogs();
  return allLogs.filter(l => l.account_id === accountId);
}

/**
 * 按API密钥ID获取日志
 */
export function getLogsByApiKeyId(apiKeyId: string): RequestLogRecord[] {
  const allLogs = getAllLogs();
  return allLogs.filter(l => l.api_key_id === apiKeyId);
}

/**
 * 计算日志统计信息
 */
export function calculateLogStats(logs: RequestLogRecord[]) {
  return {
    total_requests: logs.length,
    total_prompt_tokens: logs.reduce((sum, l) => sum + (l.prompt_tokens || 0), 0),
    total_completion_tokens: logs.reduce((sum, l) => sum + (l.completion_tokens || 0), 0),
    total_reasoning_tokens: logs.reduce((sum, l) => sum + (l.reasoning_tokens || 0), 0),
    success_count: logs.filter(l => l.status === 'success').length,
    error_count: logs.filter(l => l.status === 'error').length,
    avg_duration_ms: logs.length > 0
      ? logs.reduce((sum, l) => sum + l.duration_ms, 0) / logs.length
      : 0,
  };
}
