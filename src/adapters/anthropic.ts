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
import { toAnthropicToolUse } from '../tools/format.js';
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

function logRequest(data: {
  account_id: string;
  session_id: string | null;
  usage: MimoUsage | null;
  status: 'success' | 'error';
  error?: string;
  duration_ms: number;
}) {
  db.prepare(
    `INSERT INTO request_logs (id, account_id, session_id, endpoint, model, prompt_tokens, completion_tokens, reasoning_tokens, duration_ms, status, error, created_at)
     VALUES (?, ?, ?, 'anthropic', 'mimo-v2-pro', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(), data.account_id, data.session_id,
    data.usage?.promptTokens ?? null, data.usage?.completionTokens ?? null,
    data.usage?.reasoningTokens ?? null, data.duration_ms,
    data.status, data.error ?? null, new Date().toLocaleString('sv-SE')
  );
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
    return {
      thinkContent: text.slice(start + 7, end),
      mainContent: text.slice(end + 8).trimStart(),
    };
  }
  return { thinkContent: '', mainContent: text };
}

export function registerAnthropic(app: Hono) {
  app.post('/v1/messages', async (c) => {
    const authHeader = c.req.header('x-api-key') ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const clientSessionId = c.req.header('X-Session-ID');

    const account = authHeader ? getAccountByApiKey(authHeader) : getLeastBusyAccount();
    if (!account) return c.json({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized' } }, 401);

    if (account.active_requests >= config.maxConcurrentPerAccount) {
      return c.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } }, 429);
    }

    const body = await c.req.json();
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

    incrementActive(account.id);
    let sessionId: string | null = null;
    let lastUsage: MimoUsage | null = null;

    try {
      let conversationId: string;
      let query: string;

      const bodyMsgsRaw = (body.messages as unknown[]) ?? [];
      const embeddedSessionId = decodeSessionIdFromMessages(bodyMsgsRaw);
      const effectiveSessionKey = clientSessionId ?? embeddedSessionId;
      let effectiveClientSessionId: string;
      if (effectiveSessionKey) {
        const { conversationId: cid, reuseHistory, session } = await getOrCreateSession(account.id, effectiveSessionKey, messages);
        conversationId = cid;
        sessionId = session.id;
        effectiveClientSessionId = session.client_session_id;
        // when tools are present, always send full messages so the tool definitions are included
        query = (reuseHistory && !tools) ? extractLastUserMessage(messages) : serializeMessages(messages);
      } else {
        conversationId = uuidv4().replace(/-/g, '');
        effectiveClientSessionId = conversationId;
        query = serializeMessages(messages);
      }

      const gen = callMimo(account, conversationId, query, enableThinking, mimoModel, medias);

      if (isStream) {
        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('X-Accel-Buffering', 'no');
        return stream(c, async (s) => {
          let pingTimer: NodeJS.Timeout | null = null;
          let isAborted = false;
          
          // 监听客户端断开
          const req = c.req.raw as any;
          if (req.on) {
            req.on('close', () => {
              isAborted = true;
              if (pingTimer) clearInterval(pingTimer);
              console.log('[STREAM] Client disconnected');
            });
          }
          
          const sendEvent = async (event: string, data: unknown) => {
            if (isAborted) return;  // 客户端已断开，不再发送
            try {
              await s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch (err) {
              console.error('[STREAM] Write error:', err);
              isAborted = true;
              throw err;
            }
          };
          
          try {
            await sendEvent('message_start', {
              type: 'message_start',
              message: { id: msgId, type: 'message', role: 'assistant', content: [], model: 'mimo-v2-pro', stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
            });
            let thinkBuf = '';    // only used for passthrough accumulation
            let pastThink = false;
            let thinkingStarted = false;
            let firstBlockSent = false;
            let toolCallBuf: string | null = null;
            let pendingText = '';
            let earlyCut = false;
            pingTimer = setInterval(async () => { 
              if (!isAborted) {
                try {
                  await s.write(': ping\n\n');
                } catch (err) {
                  console.error('[STREAM] Ping error:', err);
                  isAborted = true;
                  if (pingTimer) clearInterval(pingTimer);
                }
              }
            }, 5000);
            
            for await (const chunk of gen) {
              if (isAborted) {
                console.log('[STREAM] Aborted, stopping generation');
                break;
              }
              
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
                // strip leading <think> tag from first chunk
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
                    if (thinkPart) await sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinkPart } });
                    await sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
                    await sendEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
                  } else if (config.thinkMode === 'passthrough') {
                    thinkBuf += thinkPart;
                    await sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<think>' + thinkBuf + '</think>' } });
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
                    if (text) await sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } });
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
                // past think, stream as text
                const idx = config.thinkMode === 'separate' ? 1 : 0;
                if (toolCallBuf !== null) {
                  toolCallBuf += text;
                } else {
                  pendingText += text;
                  const fc1 = pendingText.indexOf('<function_calls>'), fc2 = pendingText.indexOf('<tool_call>');
                  const fcIdx = fc1 === -1 ? fc2 : fc2 === -1 ? fc1 : Math.min(fc1, fc2);

                  if (fcIdx !== -1) {
                    // 只要检测到开始标记，就把之前安全的文本发出去，然后转入工具收集模式
                    const before = pendingText.slice(0, fcIdx);
                    if (before) await sendEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: before } });
                    toolCallBuf = pendingText.slice(fcIdx);
                    pendingText = '';
                  } else {
                    // 保持一个缓冲区（比如 15 字符），防止标签被截断时被错误发出
                    const safeLen = Math.max(0, pendingText.length - 15);
                    if (safeLen > 0) {
                      const safe = pendingText.slice(0, safeLen);
                      await sendEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: safe } });
                      pendingText = pendingText.slice(safeLen);
                    }
                  }
                }
              }
            } else if (chunk.type === 'usage') {
              lastUsage = chunk.usage!;
            } else if (chunk.type === 'finish') {
              // ensure at least one block was opened before we close it
              if (!firstBlockSent) {
                await sendEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                firstBlockSent = true;
                pastThink = true;
              }
              // handle unclosed <think> block (MiMo sometimes omits closing tag)
              if (!pastThink && thinkingStarted) {
                pastThink = true;
                if (config.thinkMode === 'separate') {
                  // thinking content already sent incrementally; close thinking block and open text block
                  await sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
                  await sendEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
                } else if (config.thinkMode === 'passthrough') {
                  await sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<think>' + thinkBuf + '</think>' } });
                }
                // strip: discard thinkBuf
              }
              // flush pending buffer
              if (pendingText) {
                const idx2 = config.thinkMode === 'separate' ? 1 : 0;
                if (toolCallBuf !== null) toolCallBuf += pendingText;
                else if (hasToolCallMarker(pendingText)) toolCallBuf = pendingText;
                else { const i = idx2; await sendEvent('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: pendingText } }); }
                pendingText = '';
              }
              // close the last active block
              const lastIdx = config.thinkMode === 'separate' && pastThink ? 1 : 0;
              // 在关闭 block 前附加零宽标记，保证客户端能收到
              await sendEvent('content_block_delta', { type: 'content_block_delta', index: lastIdx, delta: { type: 'text_delta', text: encodeSessionId(effectiveClientSessionId) } });
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
                  // parse failed — emit raw as text fallback
                  await sendEvent('content_block_delta', { type: 'content_block_delta', index: lastIdx, delta: { type: 'text_delta', text: toolCallBuf } });
                }
              }
              clearInterval(pingTimer);
              await sendEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: lastUsage?.completionTokens ?? 0 },
              });
              await sendEvent('message_stop', { type: 'message_stop' });
            }
          }
          // earlyCut: loop broke early on tool call completion, run finish logic now
          if (earlyCut) {
            if (!firstBlockSent) {
              await sendEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
              firstBlockSent = true;
              pastThink = true;
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
              const idx2 = (config.thinkMode === 'separate' && pastThink) ? 1 : 0;
              if (toolCallBuf !== null) {
                toolCallBuf += pendingText;
              } else if (hasToolCallMarker(pendingText)) {
                toolCallBuf = pendingText;
              } else {
                await sendEvent('content_block_delta', { type: 'content_block_delta', index: idx2, delta: { type: 'text_delta', text: pendingText } });
              }
              pendingText = '';
            }
            const lastIdx = config.thinkMode === 'separate' && pastThink ? 1 : 0;
            // 在关闭 block 前附加零宽标记
            await sendEvent('content_block_delta', { type: 'content_block_delta', index: lastIdx, delta: { type: 'text_delta', text: encodeSessionId(effectiveClientSessionId) } });
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
                // 如果解析失败，把原始内容作为文本发出去，防止内容丢失
                await sendEvent('content_block_delta', { type: 'content_block_delta', index: lastIdx, delta: { type: 'text_delta', text: toolCallBuf } });
              }
            }
            clearInterval(pingTimer);
            await sendEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: lastUsage?.completionTokens ?? 0 },
            });
            await sendEvent('message_stop', { type: 'message_stop' });
          } else {
            if (pingTimer) clearInterval(pingTimer);
          }
          
          } catch (err) {
            console.error('[STREAM] Error during streaming:', err);
            // 尝试发送错误事件（如果连接还在）
            if (!isAborted) {
              try {
                await sendEvent('error', {
                  type: 'error',
                  error: { type: 'api_error', message: String(err) }
                });
              } catch (e) {
                console.error('[STREAM] Failed to send error event:', e);
              }
            }
            logRequest({ account_id: account.id, session_id: sessionId, usage: lastUsage, status: 'error', error: String(err), duration_ms: Date.now() - startTime });
          } finally {
            // 确保清理定时器
            if (pingTimer) clearInterval(pingTimer);
          }
          
          if (sessionId && lastUsage) {
            const { createHash } = await import('crypto');
            const hash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
            updateSessionTokens(sessionId, lastUsage.promptTokens, hash, messages.length);
          }
          if (!isAborted) {
            logRequest({ account_id: account.id, session_id: sessionId, usage: lastUsage, status: 'success', duration_ms: Date.now() - startTime });
          }
        });
      }

      // non-stream
      let fullText = '';
      for await (const chunk of gen) {
        if (chunk.type === 'text') fullText += chunk.content ?? '';
        else if (chunk.type === 'usage') lastUsage = chunk.usage!;
      }

      if (config.thinkMode === 'strip') {
        fullText = fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trimStart();
      }

      const content: unknown[] = [];
      const marker = encodeSessionId(effectiveClientSessionId);
      if (config.thinkMode === 'separate') {
        const { thinkContent, mainContent } = processThinkContent(fullText);
        if (thinkContent) content.push({ type: 'thinking', thinking: thinkContent });
        content.push({ type: 'text', text: mainContent + marker });
      } else {
        content.push({ type: 'text', text: fullText + marker });
      }

      if (sessionId && lastUsage) {
        const { createHash } = await import('crypto');
        const hash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
        updateSessionTokens(sessionId, lastUsage.promptTokens, hash, messages.length);
      }
      logRequest({ account_id: account.id, session_id: sessionId, usage: lastUsage, status: 'success', duration_ms: Date.now() - startTime });

      let stopReason = 'end_turn';
      if (hasToolCallMarker(fullText)) {
        const calls = parseToolCalls(fullText);
        if (calls.length > 0) {
          stopReason = 'tool_use';
          for (const block of toAnthropicToolUse(calls)) content.push(block);
        }
      }

      return c.json({
        id: msgId, type: 'message', role: 'assistant', content,
        model: 'mimo-v2-pro', stop_reason: stopReason, stop_sequence: null,
        usage: { input_tokens: lastUsage?.promptTokens ?? 0, output_tokens: lastUsage?.completionTokens ?? 0 },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) markAccountInactive(account.id);
      logRequest({ account_id: account.id, session_id: sessionId, usage: null, status: 'error', error: msg, duration_ms: Date.now() - startTime });
      return c.json({ type: 'error', error: { type: 'api_error', message: msg } }, 502);
    } finally {
      decrementActive(account.id);
    }
  });
}
