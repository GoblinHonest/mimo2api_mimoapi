import { Account } from '../accounts.js';
import { randomUUID } from 'crypto';
import { MimoMedia } from './upload.js';

export interface MimoUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

export interface MimoChunk {
  type: 'text' | 'usage' | 'dialogId' | 'finish';
  content?: string;
  usage?: MimoUsage;
}

const API_URL = 'https://aistudio.xiaomimimo.com/open-apis/bot/chat';
const CONFIG_URL = 'https://aistudio.xiaomimimo.com/open-apis/bot/config';

export interface BotConfig {
  modelConfigListNg: Array<{
    name: string;
    model: string;
    pageType: string;
    redirectTo?: string;
    isNew?: boolean;
  }>;
}

interface BotConfigResponse {
  code: number;
  msg: string;
  data: BotConfig;
}

let cachedBotConfig: BotConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function fetchBotConfig(): Promise<BotConfig> {
  const now = Date.now();
  if (cachedBotConfig && (now - configCacheTime) < CONFIG_CACHE_TTL) {
    return cachedBotConfig;
  }

  const resp = await fetch(CONFIG_URL, {
    headers: {
      'Accept': '*/*',
      'Content-Type': 'application/json',
      'Origin': 'https://aistudio.xiaomimimo.com',
      'Referer': 'https://aistudio.xiaomimimo.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch bot config: ${resp.status}`);
  }

  const json = await resp.json() as BotConfigResponse;
  cachedBotConfig = json.data;
  configCacheTime = now;
  return cachedBotConfig;
}

export function getChatModels(): string[] {
  if (!cachedBotConfig) return [];
  return cachedBotConfig.modelConfigListNg
    .filter(m => m.pageType === 'chat')
    .map(m => m.model);
}

export async function* callMimo(
  account: Account,
  conversationId: string,
  query: string,
  enableThinking: boolean,
  model = 'mimo-v2-pro',
  multiMedias: MimoMedia[] = []
): AsyncGenerator<MimoChunk> {
  const body = {
    msgId: randomUUID().replace(/-/g, '').slice(0, 32),
    conversationId,
    query,
    modelConfig: {
      model,
      enableThinking,
      webSearchStatus: 'disabled'
    },
    multiMedias: multiMedias || [],
  };

  console.log('[MIMO] Request:', {
    conversationId: conversationId.slice(0, 16) + '...',
    model,
    enableThinking,
    queryLength: query.length,
    mediaCount: multiMedias.length
  });

  const url = `${API_URL}?xiaomichatbot_ph=${encodeURIComponent(account.ph_token)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `serviceToken=${account.service_token}; userId=${account.user_id}; xiaomichatbot_ph=${account.ph_token}`,
      'Origin': 'https://aistudio.xiaomimimo.com',
      'Referer': 'https://aistudio.xiaomimimo.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'x-timezone': 'Asia/Shanghai',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    // 尝试读取错误响应内容
    let errorBody = '';
    try {
      errorBody = await resp.text();
      console.error('[MIMO] ❌ Error response:', {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries()),
        body: errorBody
      });
    } catch (e) {
      console.error('[MIMO] ❌ Failed to read error body:', e);
    }
    throw new Error(`MiMo error: ${resp.status} - ${errorBody.slice(0, 500)}`);
  }
  if (!resp.body) throw new Error('No response body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event:')) {
        event = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        try {
          const data = JSON.parse(trimmed.slice(5).trim());
          if (event === 'message') {
            yield { type: 'text', content: data.content ?? '' };
          } else if (event === 'usage') {
            console.log('[MIMO] Usage:', JSON.stringify(data));
            yield {
              type: 'usage',
              usage: {
                promptTokens: data.promptTokens ?? 0,
                completionTokens: data.completionTokens ?? 0,
                totalTokens: data.totalTokens ?? 0,
                reasoningTokens: data.nativeUsage?.completion_tokens_details?.reasoning_tokens ?? 0,
              },
            };
          } else if (event === 'finish') {
            console.log('[MIMO:DEBUG] Finish event received');
            yield { type: 'finish' };
          } else if (event === 'dialogId') {
            console.log('[MIMO:DEBUG] DialogId event:', data.content);
            yield { type: 'dialogId', content: data.content };
          } else {
            console.log('[MIMO:DEBUG] Unknown event type:', event, data);
          }
        } catch (e) {
          console.error('[MIMO:ERROR] Failed to parse SSE data:', trimmed.slice(5).trim(), e);
        }
      }
    }
  }
}
