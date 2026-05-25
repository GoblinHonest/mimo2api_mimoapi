import { ProxyAgent } from 'undici';
import { config } from '../config.js';

let cachedAgent: ProxyAgent | undefined;
let cachedProxyUrl = '';

export function validateMimoProxyUrl(proxyUrl: string): string | null {
  const value = proxyUrl.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '代理地址仅支持 http:// 或 https://';
    }
    if (!parsed.hostname || !parsed.port) {
      return '代理地址需包含主机和端口';
    }
    return null;
  } catch {
    return '代理地址格式无效';
  }
}

export function getMimoProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = config.mimoProxy.trim();
  if (!proxyUrl) return undefined;

  if (!cachedAgent || cachedProxyUrl !== proxyUrl) {
    console.log(`[Proxy] MiMo 专用代理: ${proxyUrl}`);
    cachedAgent = new ProxyAgent(proxyUrl);
    cachedProxyUrl = proxyUrl;
  }

  return cachedAgent;
}

export function getMimoProxyFetchOptions(): Record<string, unknown> {
  const dispatcher = getMimoProxyDispatcher();
  return dispatcher ? { dispatcher } : {};
}
