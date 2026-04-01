import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { getAccountByApiKey, getLeastBusyAccount, incrementActive, decrementActive, markAccountInactive } from '../accounts.js';
import { callMimo, MimoUsage } from '../mimo/client.js';
import { getOrCreateSession, updateSessionTokens } from '../mimo/session.js';
import { serializeMessages, extractLastUserMessage, ChatMessage } from '../mimo/serialize.js';
import { encodeSessionId, decodeSessionIdFromMessages } from '../mimo/session-marker.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { buildToolSystemPrompt, ToolDefinition } from '../tools/prompt.js';
import { parseToolCalls, hasToolCallMarker } from '../tools/parser.js';
import { toOpenAIToolCalls } from '../tools/format.js';
import { uploadImageToMimo, fetchImageBytes, MimoMedia } from '../mimo/upload.js';
import { Account } from '../accounts.js';

const MODEL_MAP: Record<string, string> = {
  'mimo-v2-pro': 'mimo-v2-pro',
  'mimo-v2-flash-studio': 'mimo-v2-flash-studio',
  'mimo-v2-omni': 'mimo-v2-omni',
};

function resolveModel(model: string): string {
  return MODEL_MAP[model] ?? 'mimo-v2-pro';
}

function stripThink(text: string): string {
  // strip null bytes MiMo injects around think tags
  text = text.replace(/\u0000/g, '');
  // remove complete <think>...</think> blocks
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  // remove unclosed <think> block (MiMo sometimes omits closing tag)
  const openIdx = text.indexOf('<think>');
  if (openIdx !== -1) text = text.slice(0, openIdx);
  return text.trimStart();
}

function processThinkContent(text: string, mode: string): string {
  if (mode === 'strip') return stripThink(text);
  return text;
}

async function extractImages(account: Account, messages: Array<{ role: string; content: unknown }>): Promise<{ messages: Array<{ role: string; content: unknown }>; medias: MimoMedia[] }> {
  const medias: MimoMedia[] = [];
  const out = await Promise.all(messages.map(async (m) => {
    if (!Array.isArray(m.content)) return m;
    const blocks = m.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const hasImage = blocks.some(b => b.type === 'image_url');
    if (!hasImage) return m;
    const textParts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text') {
        textParts.push(b.text ?? '');
      } else if (b.type === 'image_url' && b.image_url?.url) {
        const { data, mimeType } = await fetchImageBytes(b.image_url.url);
        const media = await uploadImageToMimo(account, data, mimeType);
        medias.push(media);
      }
    }
    return { role: m.role, content: textParts.join('\n') };
  }));
  return { messages: out, medias };
}

function logRequest(data: {
  account_id: string;
  session_id: string | null;
  model: string;
  usage: MimoUsage | null;
  status: 'success' | 'error';
  error?: string;
  duration_ms: number;
}) {
  db.prepare(
    `INSERT INTO request_logs (id, account_id, session_id, endpoint, model, prompt_tokens, completion_tokens, reasoning_tokens, duration_ms, status, error, created_at)
     VALUES (?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(), data.account_id, data.session_id, data.model,
    data.usage?.promptTokens ?? null, data.usage?.completionTokens ?? null,
    data.usage?.reasoningTokens ?? null, data.duration_ms,
    data.status, data.error ?? null, new Date().toLocaleString('sv-SE')
  );
}

export function registerOpenAI(app: Hono) {
  app.get('/v1/models', (c) => {
    const models = Object.keys(MODEL_MAP).map(id => ({
      id, object: 'model', created: 1700000000, owned_by: 'mimo',
    }));
    return c.json({ object: 'list', data: models });
  });

  app.post('/v1/chat/completions', async (c) => {
    const authHeader = c.req.header('Authorization') ?? '';
    const apiKey = authHeader.replace(/^Bearer\s+/i, '').trim();
    const clientSessionId = c.req.header('X-Session-ID');

    const account = apiKey ? getAccountByApiKey(apiKey) : getLeastBusyAccount();
    if (!account) return c.json({ error: { message: 'Unauthorized or no active account', type: 'auth_error' } }, 401);

    if (account.active_requests >= config.maxConcurrentPerAccount) {
      return c.json({ error: { message: 'Too many requests for this account', type: 'rate_limit' } }, 429);
    }

    const body = await c.req.json();
    const { messages: cleanedMsgs, medias } = await extractImages(account, body.messages ?? []);
    const rawMessages: ChatMessage[] = cleanedMsgs as ChatMessage[];
    const tools: ToolDefinition[] | undefined = body.tools?.length ? body.tools : undefined;
    const isStream: boolean = body.stream ?? false;
    const enableThinking: boolean = !!body.reasoning_effort;
    const mimoModel = resolveModel(body.model ?? '');
    const startTime = Date.now();

    // inject tool definitions into system prompt
    let messages = rawMessages;
    if (tools) {
      const toolPrompt = buildToolSystemPrompt(tools);
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        messages = messages.map((m, i) => i === sysIdx ? { ...m, content: m.content + '\n\n' + toolPrompt } : m);
      } else {
        messages = [{ role: 'system', content: toolPrompt }, ...messages];
      }
    }

    incrementActive(account.id);
    let sessionId: string | null = null;
    let lastUsage: MimoUsage | null = null;

    try {
      let conversationId: string;
      let query: string;

      const embeddedSessionId = decodeSessionIdFromMessages(rawMessages);
      const effectiveSessionKey = clientSessionId ?? embeddedSessionId;
      let effectiveClientSessionId: string;
      if (effectiveSessionKey) {
        const { conversationId: cid, reuseHistory, session } = await getOrCreateSession(account.id, effectiveSessionKey, messages);
        conversationId = cid;
        sessionId = session.id;
        effectiveClientSessionId = session.client_session_id;
        query = (reuseHistory && !tools) ? extractLastUserMessage(messages) : serializeMessages(messages);
      } else {
        conversationId = uuidv4().replace(/-/g, '');
        effectiveClientSessionId = conversationId;
        query = serializeMessages(messages);
      }

      const gen = callMimo(account, conversationId, query, enableThinking, mimoModel, medias);
      const responseId = `chatcmpl-${uuidv4().replace(/-/g, '')}`;
      const created = Math.floor(Date.now() / 1000);

      if (isStream) {
        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('X-Accel-Buffering', 'no');
        return stream(c, async (s) => {
          const sendDelta = async (delta: object) => {
            await s.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model: mimoModel, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          };
          let pastThink = false;
          let thinkingStarted = false;
          let thinkBuf = '';
          let toolCallBuf: string | null = null;
          let pendingText = '';
          for await (const chunk of gen) {
            if (chunk.type === 'text') {
              let text = (chunk.content ?? '').replace(/\u0000/g, '');
              if (!pastThink && !thinkingStarted && text && !text.includes('<think>')) pastThink = true;
              if (!pastThink) {
                if (!thinkingStarted && text.includes('<think>')) {
                  thinkingStarted = true;
                  text = text.replace('<think>', '');
                }
                const closeIdx = text.indexOf('</think>');
                if (closeIdx !== -1) {
                  pastThink = true;
                  const thinkPart = text.slice(0, closeIdx);
                  const afterThink = text.slice(closeIdx + 8).trimStart();
                  if (config.thinkMode === 'separate') {
                    if (thinkPart) await sendDelta({ reasoning_content: thinkPart });
                  } else if (config.thinkMode === 'passthrough') {
                    thinkBuf += thinkPart;
                    await sendDelta({ content: '<think>' + thinkBuf + '</think>' });
                  }
                  // route afterThink through pendingText for tool call detection
                  if (afterThink) {
                    // 将 afterThink 重新赋值给 text，继续处理（不要 continue）
                    text = afterThink;
                    // 注意：这里不能 continue，需要继续执行到下面的 pastThink 处理逻辑
                  } else {
                    continue;  // 如果没有 afterThink，跳过本次循环
                  }
                } else {
                  // still inside think
                  if (config.thinkMode === 'separate') {
                    thinkBuf += text;
                    if (text) await sendDelta({ reasoning_content: text });
                  } else if (config.thinkMode === 'passthrough') {
                    thinkBuf += text;
                  }
                  // strip: discard
                  continue;  // 跳过本次循环，不处理 pastThink 分支
                }
              }
              
              // pastThink 处理逻辑（无论是一开始就 pastThink，还是刚刚设置的）
              if (pastThink) {
                // strip any second <think>...</think> blocks that leak through after pastThink
                text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
                const t2Idx = text.indexOf('<think>');
                if (t2Idx !== -1) text = text.slice(0, t2Idx);
                if (!text) continue;
                if (toolCallBuf !== null) {
                  toolCallBuf += text;
                } else {
                  pendingText += text;
                  const fc1 = pendingText.indexOf('<function_calls>'), fc2 = pendingText.indexOf('<tool_call>');
                  const fcIdx = fc1 === -1 ? fc2 : fc2 === -1 ? fc1 : Math.min(fc1, fc2);
                  if (fcIdx !== -1) {
                    const before = pendingText.slice(0, fcIdx);
                    if (before) await sendDelta({ content: before });
                    toolCallBuf = pendingText.slice(fcIdx);
                    pendingText = '';
                  } else {
                    // flush safe portion (keep last 15 chars in case marker spans chunks)
                    const safe = pendingText.slice(0, Math.max(0, pendingText.length - 15));
                    if (safe) await sendDelta({ content: safe });
                    pendingText = pendingText.slice(safe.length);
                  }
                }
              }
            } else if (chunk.type === 'usage') {
              lastUsage = chunk.usage!;
            } else if (chunk.type === 'finish') {
              // handle unclosed <think> block (MiMo sometimes omits closing tag)
              if (!pastThink && thinkingStarted) {
                pastThink = true;
                if (config.thinkMode === 'passthrough') {
                  await sendDelta({ content: '<think>' + thinkBuf + '</think>' });
                }
                // separate: already sent incrementally; strip: discard
              }
              // flush pending buffer
              if (pendingText) {
                if (toolCallBuf !== null) toolCallBuf += pendingText;
                else if (hasToolCallMarker(pendingText)) toolCallBuf = pendingText;
                else await sendDelta({ content: pendingText });
                pendingText = '';
              }
              const usageChunk = lastUsage ? {
                prompt_tokens: lastUsage.promptTokens,
                completion_tokens: lastUsage.completionTokens,
                total_tokens: lastUsage.totalTokens,
                completion_tokens_details: { reasoning_tokens: lastUsage.reasoningTokens },
              } : undefined;
              let finishReason = 'stop';
              // 先发零宽标记到 content，tool_calls 时客户端也会保留此 content
              await sendDelta({ content: encodeSessionId(effectiveClientSessionId) });
              if (toolCallBuf && hasToolCallMarker(toolCallBuf)) {
                const calls = parseToolCalls(toolCallBuf);
                if (calls.length > 0) {
                  finishReason = 'tool_calls';
                  await sendDelta({ tool_calls: toOpenAIToolCalls(calls).map((tc, i) => ({ index: i, ...tc })) });
                } else {
                  // 如果识别到了标记但解析不出有效的工具调用，则把原始内容发出去，防止内容丢失
                  await sendDelta({ content: toolCallBuf });
                }
              }
              await s.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model: mimoModel, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: usageChunk })}\n\n`);
              await s.write('data: [DONE]\n\n');
            }
          }
          if (sessionId && lastUsage) {
            const { createHash } = await import('crypto');
            const hash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
            updateSessionTokens(sessionId, lastUsage.promptTokens, hash, messages.length);
          }
          logRequest({ account_id: account.id, session_id: sessionId, model: mimoModel, usage: lastUsage, status: 'success', duration_ms: Date.now() - startTime });
        });
      }

      // non-stream
      let fullText = '';
      for await (const chunk of gen) {
        if (chunk.type === 'text') fullText += chunk.content ?? '';
        else if (chunk.type === 'usage') lastUsage = chunk.usage!;
      }
      fullText = processThinkContent(fullText, config.thinkMode);

      if (sessionId && lastUsage) {
        const { createHash } = await import('crypto');
        const hash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
        updateSessionTokens(sessionId, lastUsage.promptTokens, hash, messages.length);
      }
      logRequest({ account_id: account.id, session_id: sessionId, model: mimoModel, usage: lastUsage, status: 'success', duration_ms: Date.now() - startTime });

      const usageObj = lastUsage ? {
        prompt_tokens: lastUsage.promptTokens,
        completion_tokens: lastUsage.completionTokens,
        total_tokens: lastUsage.totalTokens,
        completion_tokens_details: { reasoning_tokens: lastUsage.reasoningTokens },
      } : undefined;

      if (hasToolCallMarker(fullText)) {
        const calls = parseToolCalls(fullText);
        if (calls.length > 0) {
          return c.json({
            id: responseId, object: 'chat.completion', created, model: mimoModel,
            choices: [{ index: 0, message: { role: 'assistant', content: encodeSessionId(effectiveClientSessionId), tool_calls: toOpenAIToolCalls(calls) }, finish_reason: 'tool_calls' }],
            usage: usageObj,
          });
        }
      }

      return c.json({
        id: responseId, object: 'chat.completion', created, model: mimoModel,
        choices: [{ index: 0, message: { role: 'assistant', content: fullText + encodeSessionId(effectiveClientSessionId) }, finish_reason: 'stop' }],
        usage: usageObj,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) markAccountInactive(account.id);
      logRequest({ account_id: account.id, session_id: sessionId, model: mimoModel, usage: null, status: 'error', error: msg, duration_ms: Date.now() - startTime });
      return c.json({ error: { message: msg, type: 'api_error' } }, 502);
    } finally {
      decrementActive(account.id);
    }
  });
}
