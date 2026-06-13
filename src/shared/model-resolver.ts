import { fetchBotConfig } from '../mimo/client.js';

// 静态 fallback（网络失败时使用）
export const MODEL_MAP: Record<string, string> = {
  'mimo-v2.5-pro': 'mimo-v2.5-pro',
  'mimo-v2.5': 'mimo-v2.5',
};

// 缓存模型配置
let cachedModels: Array<{ model: string; redirectTo?: string }> | null = null;

// 动态模型解析（支持 redirectTo）
function resolveModelDynamic(model: string): string {
  if (!cachedModels) return MODEL_MAP[model] ?? 'mimo-v2-pro';
  const entry = cachedModels.find(m => m.model === model);
  if (entry) {
    return entry.redirectTo ?? entry.model;
  }
  return 'mimo-v2.5'; // 未知模型默认
}

export async function getResolvedModel(model: string): Promise<string> {
  if (!cachedModels) {
    try {
      const botConfig = await fetchBotConfig();
      cachedModels = botConfig.modelConfigListNg
        .filter(m => m.pageType === 'chat' && m.isNew === true)
        .map(m => ({ model: m.model, redirectTo: m.redirectTo }));
    } catch (err) {
      console.error('[MODEL] Failed to fetch bot config:', err);
      cachedModels = null;
    }
  }
  return resolveModelDynamic(model);
}

export function resolveModel(model: string): string {
  return resolveModelDynamic(model);
}
