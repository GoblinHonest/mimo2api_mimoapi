import { createHash } from 'crypto';
import { Context } from 'hono';

/**
 * 消息历史连续性方案
 * 通过检测新消息是否包含上一次的消息来判断会话连续性
 */

/**
 * 计算消息列表的指纹（用于快速匹配）
 *
 * 策略：只对 user 和 assistant 消息计算指纹，排除 system 消息
 * 原因：system 消息可能包含动态内容（如 tools 列表），会导致指纹变化
 */
export function calculateMessageFingerprint(messages: any[]): string {
  // 过滤掉 system、tool 消息和带 tool_calls 的 assistant 消息
  // 只保留纯 user 和纯 assistant 消息用于判断对话连续性
  const nonSystemMessages = messages.filter(
    m => m.role !== 'system' && m.role !== 'tool' && !m.tool_calls
  );

  // 如果没有非 system 消息，返回空指纹
  if (nonSystemMessages.length === 0) {
    return '';
  }

  // 只取最后几条消息计算指纹（避免过长）
  const recentMessages = nonSystemMessages.slice(-5);
  const content = JSON.stringify(recentMessages.map(m => {
    let contentStr: string;
    if (typeof m.content === 'string') {
      contentStr = m.content;
    } else if (Array.isArray(m.content)) {
      // 处理数组类型的 content（如 OpenAI 的多模态消息）
      contentStr = JSON.stringify(m.content);
    } else if (m.content && typeof m.content === 'object') {
      // 处理对象类型的 content
      contentStr = JSON.stringify(m.content);
    } else {
      contentStr = String(m.content || '');
    }
    return {
      role: m.role,
      content: contentStr.slice(0, 200)
    };
  }));

  const fingerprint = createHash('sha256').update(content).digest('hex');

  console.log('[FINGERPRINT] Calculated:', {
    totalMessages: messages.length,
    nonSystemMessages: nonSystemMessages.length,
    contentPreview: content.slice(0, 100) + '...',
    fingerprint: fingerprint.slice(0, 16) + '...'
  });

  return fingerprint;
}

/**
 * 生成客户端会话标识（备用方案）
 */
export function generateClientSessionId(c: Context, accountId: string): string {
  // 优先使用客户端提供的会话ID
  const explicitSessionId = c.req.header('x-session-id');
  if (explicitSessionId) {
    console.log('[SESSION] Using explicit session ID from header');
    return `explicit_${accountId}_${explicitSessionId}`;
  }

  // 默认：基于账号的会话
  console.log('[SESSION] Using account-based session (fallback)');
  return `account_${accountId}`;
}
