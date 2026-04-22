import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { decrementActive } from '../accounts.js';
import { callMimo, MimoUsage } from '../mimo/client.js';
import { serializeMessages, ChatMessage } from '../mimo/serialize.js';
import { config } from '../config.js';
import { buildToolSystemPrompt, ToolDefinition } from '../tools/prompt.js';
import { parseToolCalls, hasToolCallMarker } from '../tools/parser.js';
import { toAnthropicToolUse } from '../tools/format.js';
import { uploadImageToMimo, fetchImageBytes, MimoMedia } from '../mimo/upload.js';
import { Account } from '../accounts.js';
import { getOrCreateSession, updateSessionTokens } from '../mimo/session.js';
import { extractApiKey, authenticateRequest, acquireAccountForRequest, logApiRequest, handleAccountError } from '../middleware/request-handler.js';
import { generateClientSessionId } from '../mimo/session-marker.js';

const MODEL_MAP: Record<string, string> = {
  'mimo-v2-pro': 'mimo-v2-pro',
  'mimo-v2-flash-studio': 'mimo-v2-flash-studio',
  'mimo-v2-omni': 'mimo-v2-omni',
};

function resolveModel(model: string): string {
  return MODEL_MAP[model] ?? 'mimo-v2-pro';
}

function logRequest(data: {
  account_id: string;
  api_key_id: string | null;
  usage: MimoUsage | null;
  status: 'success' | 'error';
  error?: string;
  duration_ms: number;
}) {
  logApiRequest({ ...data, endpoint: 'anthropic', model: 'mimo-v2-pro' });
}

async function extractImagesAnthropic(account: Account, body: Record<string, unknown>): Promise<MimoMedia[]> {
  const medias: MimoMedia[] = [];
  const bodyMsgs = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
  for (const m of bodyMsgs) {
    if (!Array.isArray(m.content)) continue;
    const blocks = m.content as Array<{ type: string; source?: { type: string; media_type?: string; data?: string; url?: string } }>;
    for (const b of blocks) {
      if (b.type !== 'image' || !b.source) continue;
      const src = b.source;
      let imageUrl: string;
      if (src.type === 'base64' && src.data && src.media_type) {
        imageUrl = `data:${src.media_type};base64,${src.data}`;
      } else if (src.type === 'url' && src.url) {
        imageUrl = src.url;
      } else continue;
      const { data, mimeType } = await fetchImageBytes(imageUrl);
      medias.push(await uploadImageToMimo(account, data, mimeType));
    }
  }
  return medias;
}

function buildMessages(body: Record<string, unknown>): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  if (body.system && typeof body.system === 'string') {
    msgs.push({ role: 'system', content: body.system });
  }
  const bodyMsgs = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
  for (const m of bodyMsgs) {
    let content: string;
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      const blocks = m.content as Array<{ type: string; text?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }>;
      const parts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          parts.push(b.text ?? '');
        } else if (b.type === 'tool_use') {
          parts.push(`<tool_call>\n${JSON.stringify({ name: b.name, arguments: b.input })}\n</tool_call>`);
        } else if (b.type === 'tool_result') {
          const resultContent = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? (b.content as Array<{type:string;text?:string}>).filter(x=>x.type==='text').map(x=>x.text??'').join('') : JSON.stringify(b.content);
          parts.push(`[工具结果]\n${resultContent}`);
        }
      }
      content = parts.join('\n');
    } else {
      content = '';
    }
    if (content) msgs.push({ role: m.role as 'user' | 'assistant', content });
  }
  return msgs;
}

function processThinkContent(text: string): { thinkContent: string; mainContent: string } {
  const start = text.indexOf('<think>');
  const end = text.indexOf('</think>');
  if (start !== -1 && end !== -1) {
    return { thinkContent: text.slice(start + 7, end), mainContent: text.slice(end + 8).trimStart() };
  }
  return { thinkContent: '', mainContent: text };
}

export function registerAnthropic(app: Hono) {
  app.post('/v1/messages', async (c) => {
    console.log('\n[REQ] ========== New Anthropic Request ==========');

    const apiKey = extractApiKey(c);

    // 1. 认证检查
    const apiKeyRecord = authenticateRequest(apiKey);
    if (!apiKeyRecord) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: apiKey ? 'Invalid API key' : 'Missing API key' } }, 401);
    }

    // 2. 原子性选择账号并递增并发计数
    const acquired = acquireAccountForRequest(apiKeyRecord);
    if (!acquired) {
      return c.json({ type: 'error', error: { type: 'service_error', message: 'No active account available' } }, 503);
    }
    const { account } = acquired;

    const body = await c.req.json();
    console.log('[REQ] Body parsed:', { model: body.model || 'default', stream: body.stream ?? false, messages: body.messages?.length || 0, tools: body.tools?.length || 0, thinking: body.thinking?.type === 'enabled' });
    console.log('[ANT] tools:', JSON.stringify(body.tools?.map((t: Record<string,unknown>) => t.name ?? t.function) ?? null));

    const medias = await extractImagesAnthropic(account, body);
    const mimoModel = resolveModel(body.model ?? '');
    const isStream: boolean = body.stream ?? false;
    const enableThinking: boolean = body.thinking?.type === 'enabled';
    const tools: ToolDefinition[] | undefined = body.tools?.length ? body.tools : undefined;
    let messages = buildMessages(body);
    if (tools) {
      const toolPrompt = buildToolSystemPrompt(tools);
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        messages = messages.map((m, i) => i === sysIdx ? { ...m, content: m.content + '\n\n' + toolPrompt } : m);
      } else {
        messages = [{ role: 'system', content: toolPrompt }, ...messages];
      }
    }

    const startTime = Date.now();
    const msgId = `msg_${uuidv4().replace(/-/g, '')}`;
    console.log('[REQ] 🚀 Starting request processing...');
    let lastUsage: MimoUsage | null = null;

    try {
      // 1. 生成客户端会话标识（备用）
      const clientSessionId = generateClientSessionId(c, account.id);
      
      // 2. 获取或创建会话（基于消息历史连续性）
      const { conversationId, session } = await getOrCreateSession(
        account.id,
        clientSessionId,
        messages
      );
      
      console.log('[SESSION] Using conversation:', {
        conversationId: conversationId.slice(0, 16) + '...',
        sessionId: session.id.slice(0, 8) + '...',
        cumulativeTokens: session.cumulative_prompt_tokens
      });
      
      const query = serializeMessages(messages);
      console.log('[MIMO] Calling MiMo API...', { model: mimoModel, thinking: enableThinking, queryLength: query.length, hasMedia: medias.length > 0 });

      const gen = callMimo(account, conversationId, query, enableThinking, mimoModel, medias);

      if (isStream) {
        console.log('[STREAM] Starting streaming response...');
        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('X-Accel-Buffering', 'no');
        return stream(c, async (s) => {
          let pingTimer: NodeJS.Timeout | null = null;
          let isAborted = false;
          let eventCount = 0;
          let loggedError = false;

          const req = c.req.raw as any;
          if (req.on) {
            req.on('close', () => {
              isAborted = true;
              if (pingTimer) clearInterval(pingTimer);
              console.log('[STREAM] ⚠️ Client disconnected after', eventCount, 'events');
            });
          }

          const sendEvent = async (event: string, data: unknown) => {
            if (isAborted) return;
            try {
              await s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
              eventCount++;
            } catch (err) {
              console.error('[STREAM] ❌ Write error:', err);
              isAborted = true;
              throw err;
            }
          };

          try {
            console.log('[STREAM] Waiting for MiMo response...');
            await sendEvent('message_start', {
              type: 'message_start',
              message: { id: msgId, type: 'message', role: 'assistant', content: [], model: 'mimo-v2-pro', stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
            });
            let thinkBuf = '';
            let pastThink = false;
            let thinkingStarted = false;
            let firstBlockSent = false;
            let toolCallBuf: string | null = null;
            let pendingText = '';
            pingTimer = setInterval(async () => {
              if (!isAborted) {
                try { await s.write(': ping\n\n'); }
                catch (err) { console.error('[STREAM] Ping error:', err); isAborted = true; if (pingTimer) clearInterval(pingTimer); }
              }
            }, 5000);

            for await (const chunk of gen) {
              if (isAborted) { console.log('[STREAM] Aborted, stopping generation'); break; }

              if (chunk.type === 'text') {
                let text = (chunk.content ?? '').replace(/\u0000/g, '');
                if (text) console.log('[DBG] chunk:', JSON.stringify(text.slice(0, 80)), 'pastThink:', pastThink, 'tcBuf:', toolCallBuf !== null);
                if (!pastThink && !thinkingStarted && text && !text.includes('<think>')) {
                  pastThink = true;
                  if (!firstBlockSent) {
                    await sendEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                    firstBlockSent = true;
                  }
                }
                if (!pastThink) {
                  if (!thinkingStarted && text.includes('<think>')) {
                    thinkingStarted = true;
                    text = text.replace('<think>', '');
                    if (config.thinkMode === 'separate') {
                      await sendEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
                      firstBlockSent = true;
                    } else if (!firstBlockSent) {
                      await sendEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                      firstBlockSent = true;
                    }
                  }
                  const closeIdx = text.indexOf('</think>');
                  if (closeIdx !== -1) {
                    pastThink = true;
                    const thinkPart = text.slice(0, closeIdx);
                    const afterThink = text.slice(closeIdx + 8).trimStart();
                    if (config.thinkMode === 'separate') {
                      if (thinkPart) {
                        console.log('[DBG] Sending thinking_delta:', JSON.stringify(thinkPart.slice(0, 50)));
                        await sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinkPart } });
                      }
                      await sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
                      await sendEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
                    } else if (config.thinkMode === 'passthrough') {
                      thinkBuf += thinkPart;
                      await sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<think>' + thinkBuf + '</think>' } });
                    }
                    if (afterThink) { text = afterThink; } else { continue; }
                  } else {
                    if (config.thinkMode === 'separate') {
                      if (text) {
                        console.log('[DBG] Sending thinking_delta chunk:', JSON.stringify(text.slice(0, 50)));
                        await sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } });
                      }
                    } else if (config.thinkMode === 'passthrough') {
                      thinkBuf += text;
                    }
                    continue;
                  }
                }

                if (pastThink) {
                  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
                  const t2Idx = text.indexOf('<think>');
                  if (t2Idx !== -1) text = text.slice(0, t2Idx);
                  if (!text) continue;
                  
                  const idx = config.thinkMode === 'separate' ? 1 : 0;
                  if (toolCallBuf !== null) {
                    toolCallBuf += text;
                  } else {
                    pendingText += text;
                    const fc1 = pendingText.indexOf('<function_calls>');
                    const fc2 = pendingText.indexOf('<tool_call>');
                    const fc3 = pendingText.indexOf('<toolcall');
                    // 检测 {"name": 格式的工具调用（MiMo 未包裹 <tool_call> 时）
                    let fc4 = -1;
                    const namedJsonMatch = pendingText.match(/\{\s*"name"\s*:\s*"[A-Z]/);
                    if (namedJsonMatch && namedJsonMatch.index !== undefined) {
                      fc4 = namedJsonMatch.index;
                    }
                    const fcIdx = [fc1, fc2, fc3, fc4].filter(i => i !== -1).sort((a, b) => a - b)[0] ?? -1;
                    if (fcIdx !== -1) {
                      const before = pendingText.slice(0, fcIdx);
                      if (before) await sendEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: before } });
                      toolCallBuf = pendingText.slice(fcIdx);
                      pendingText = '';
                    } else {
                      const safeLen = Math.max(0, pendingText.length - 20);
                      if (safeLen > 0) {
                        await sendEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: pendingText.slice(0, safeLen) } });
                        pendingText = pendingText.slice(safeLen);
                      }
                    }
                  }
                }
              } else if (chunk.type === 'usage') {
                lastUsage = chunk.usage!;
              } else if (chunk.type === 'finish') {
                if (!firstBlockSent) {
                  await sendEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                  firstBlockSent = true; pastThink = true;
                }
                if (!pastThink && thinkingStarted) {
                  pastThink = true;
                  if (config.thinkMode === 'separate') {
                    await sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
                    await sendEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
                  } else if (config.thinkMode === 'passthrough') {
                    await sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<think>' + thinkBuf + '</think>' } });
                  }
                }
                if (pendingText) {
                  const idx2 = config.thinkMode === 'separate' ? 1 : 0;
                  if (toolCallBuf !== null) toolCallBuf += pendingText;
                  else if (hasToolCallMarker(pendingText)) toolCallBuf = pendingText;
                  else await sendEvent('content_block_delta', { type: 'content_block_delta', index: idx2, delta: { type: 'text_delta', text: pendingText } });
                  pendingText = '';
                }
                const lastIdx = config.thinkMode === 'separate' && pastThink ? 1 : 0;
                await sendEvent('content_block_stop', { type: 'content_block_stop', index: lastIdx });
                let stopReason = 'end_turn';
                if (toolCallBuf && hasToolCallMarker(toolCallBuf)) {
                  const calls = parseToolCalls(toolCallBuf);
                  if (calls.length > 0) {
                    stopReason = 'tool_use';
                    const toolUseBlocks = toAnthropicToolUse(calls);
                    for (let i = 0; i < toolUseBlocks.length; i++) {
                      const blockIdx = lastIdx + 1 + i;
                      await sendEvent('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: toolUseBlocks[i].id, name: toolUseBlocks[i].name, input: {} } });
                      await sendEvent('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUseBlocks[i].input) } });
                      await sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIdx });
                    }
                  } else {
                    // 解析失败，尝试提取工具调用之前的文本
                    const toolCallStart = Math.min(
                      toolCallBuf.indexOf('<toolcall') !== -1 ? toolCallBuf.indexOf('<toolcall') : Infinity,
                      toolCallBuf.indexOf('<tool_call') !== -1 ? toolCallBuf.indexOf('<tool_call') : Infinity,
                      toolCallBuf.indexOf('<function_calls>') !== -1 ? toolCallBuf.indexOf('<function_calls>') : Infinity
                    );
                    if (toolCallStart !== Infinity && toolCallStart > 0) {
                      await sendEvent('content_block_delta', { type: 'content_block_delta', index: lastIdx, delta: { type: 'text_delta', text: toolCallBuf.slice(0, toolCallStart) } });
                    } else {
                      await sendEvent('content_block_delta', { type: 'content_block_delta', index: lastIdx, delta: { type: 'text_delta', text: toolCallBuf } });
                    }
                  }
                }
                clearInterval(pingTimer!);
                await sendEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: lastUsage?.completionTokens ?? 0 } });
                await sendEvent('message_stop', { type: 'message_stop' });
                console.log('[STREAM] ✓ Completed:', { events: eventCount, stopReason, tokens: lastUsage?.totalTokens || 0, duration: Date.now() - startTime + 'ms' });
              }
            }
          } catch (err) {
            console.error('[STREAM] ❌ Error during streaming:', err);
            if (!isAborted) {
              try { await sendEvent('error', { type: 'error', error: { type: 'api_error', message: String(err) } }); } catch {}
            }
            logRequest({ account_id: account.id, api_key_id: apiKeyRecord.id, usage: lastUsage, status: 'error', error: String(err), duration_ms: Date.now() - startTime });
            loggedError = true;
          } finally {
            if (pingTimer) clearInterval(pingTimer);
            decrementActive(account.id);
          }

          if (!isAborted && !loggedError) {
            logRequest({ account_id: account.id, api_key_id: apiKeyRecord.id, usage: lastUsage, status: 'success', duration_ms: Date.now() - startTime });
            // 更新会话 token 统计
            if (lastUsage) {
              updateSessionTokens(session.id, lastUsage.promptTokens);
            }
          }
        });
      }

      // non-stream
      console.log('[REQ] Non-streaming mode, collecting response...');
      let fullText = '';
      for await (const chunk of gen) {
        if (chunk.type === 'text') fullText += chunk.content ?? '';
        else if (chunk.type === 'usage') lastUsage = chunk.usage!;
      }
      
      if (config.thinkMode === 'strip') {
        fullText = fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trimStart();
      }
      const content: unknown[] = [];
      if (config.thinkMode === 'separate') {
        const { thinkContent, mainContent } = processThinkContent(fullText);
        if (thinkContent) content.push({ type: 'thinking', thinking: thinkContent });
        content.push({ type: 'text', text: mainContent });
      } else {
        content.push({ type: 'text', text: fullText });
      }
      let stopReason = 'end_turn';
      if (hasToolCallMarker(fullText)) {
        const calls = parseToolCalls(fullText);
        if (calls.length > 0) {
          stopReason = 'tool_use';
          for (const block of toAnthropicToolUse(calls)) content.push(block);
        }
      }
      logRequest({ account_id: account.id, api_key_id: apiKeyRecord.id, usage: lastUsage, status: 'success', duration_ms: Date.now() - startTime });
      // 更新会话 token 统计
      if (lastUsage) {
        updateSessionTokens(session.id, lastUsage.promptTokens);
      }
      return c.json({
        id: msgId, type: 'message', role: 'assistant', content,
        model: 'mimo-v2-pro', stop_reason: stopReason, stop_sequence: null,
        usage: { input_tokens: lastUsage?.promptTokens ?? 0, output_tokens: lastUsage?.completionTokens ?? 0 },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      handleAccountError(account, msg);
      logRequest({ account_id: account.id, api_key_id: apiKeyRecord.id, usage: null, status: 'error', error: msg, duration_ms: Date.now() - startTime });
      return c.json({ type: 'error', error: { type: 'api_error', message: msg } }, 502);
    } finally {
      if (!isStream) decrementActive(account.id);
    }
  });
}
