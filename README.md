# MiMo Proxy

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6.svg)](https://www.typescriptlang.org/)

将小米 MiMo AI 转换为 OpenAI / Anthropic 兼容 API 的代理服务。支持多账号负载均衡、会话保持、Tool Calling，可直接对接各类 AI 编程客户端。

## 功能特性

**API 兼容**
- OpenAI `v1/chat/completions`（流式 & 非流式）
- Anthropic `v1/messages`（流式 & 非流式）
- 多模态图片理解（自动上传至小米 OSS）

**客户端兼容**
- Cline / Kilo Code / Roo Code / Cursor 等 AI 编程工具
- 任何支持 OpenAI 或 Anthropic API 的客户端

**核心能力**
- 多账号负载均衡 — 自动选择最空闲账号，提升并发
- 会话保持（Context Replay）— 减少 token 消耗，维持对话连贯
- Tool Calling — XML 工具调用自动转换为 OpenAI/Anthropic 原生格式
- 推理内容三种模式：`passthrough` / `strip` / `separate`
- 会话隔离：`auto`（按 IP+UA）/ `manual` / `per-request`

**管理**
- Web 管理面板（账号、API 密钥、请求日志、统计图表）
- REST 管理 API
- SQLite 持久化存储

## 快速开始

```bash
# 克隆项目
git clone https://github.com/GoblinHonest/mimo2api_mimoapi.git
cd mimo2api_mimoapi

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，至少修改 ADMIN_KEY（默认管理密码为 admin）

# 启动
npm start        # 生产模式
npm run dev      # 开发模式（热重载）
```

服务默认运行在 `http://localhost:8080`。

> 管理面板默认密码：`admin`，登录后可修改。首次使用需在管理面板创建 API 密钥供客户端调用。

### Docker 部署

```bash
docker compose up -d
```

## 添加 MiMo 账号

### 方式一：粘贴 cURL（推荐）

1. 浏览器打开 [MiMo AI Studio](https://aistudio.xiaomimimo.com)，登录后进入对话
2. 打开 DevTools → Network，找到 `chat` 请求
3. 右键 → Copy as cURL
4. 打开管理面板 `http://localhost:8080`，粘贴导入

### 方式二：API 添加

```bash
curl -X POST http://localhost:8080/admin/accounts \
  -H "X-Admin-Key: <admin-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "service_token": "...",
    "user_id": "...",
    "ph_token": "...",
    "alias": "备注名"
  }'
```

## 使用示例

在管理面板创建 API 密钥后，将 `base_url` 指向本服务即可。

### OpenAI 格式

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2-pro",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### Anthropic 格式

```bash
curl http://localhost:8080/v1/messages \
  -H "x-api-key: <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2-pro",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### Tool Calling

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2-pro",
    "messages": [{"role": "user", "content": "帮我读取 package.json 文件"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "Read",
        "description": "读取文件内容",
        "parameters": {
          "type": "object",
          "properties": {
            "file_path": {"type": "string", "description": "文件路径"}
          },
          "required": ["file_path"]
        }
      }
    }],
    "stream": true
  }'
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 监听端口 |
| `ADMIN_KEY` | `admin` | 管理面板密钥，**务必修改** |
| `MAX_REPLAY_MESSAGES` | `20` | 会话回放消息数上限 |
| `MAX_QUERY_CHARS` | `12000` | 单次请求最大字符数 |
| `CONTEXT_RESET_THRESHOLD` | `0` | 超过此 token 数重置会话（0=不限） |
| `MAX_CONCURRENT_PER_ACCOUNT` | `999999` | 单账号最大并发数 |
| `THINK_MODE` | `separate` | 推理内容模式：`passthrough` / `strip` / `separate` |
| `SESSION_TTL_DAYS` | `7` | 会话保留天数 |
| `SESSION_ISOLATION` | `auto` | 会话隔离：`auto` / `manual` / `per-request` |

### THINK_MODE

| 值 | 行为 |
|----|------|
| `passthrough` | 原样返回 `<think>...</think>` 标签 |
| `strip` | 移除推理内容，只返回最终答案 |
| `separate` | 推理内容放入独立字段（Anthropic 格式为 `thinking` block） |

### SESSION_ISOLATION

| 值 | 行为 |
|----|------|
| `auto` | 按 IP + User-Agent 自动隔离，不同客户端互不干扰（推荐） |
| `manual` | 仅在客户端提供 `x-session-id` 时隔离 |
| `per-request` | 每次请求创建新会话（禁用记忆） |

## 项目结构

```
src/
├── adapters/          # API 协议适配层
│   ├── openai.ts      #   OpenAI 兼容接口
│   └── anthropic.ts   #   Anthropic 兼容接口
├── mimo/              # MiMo 客户端交互
│   ├── client.ts      #   API 调用 & 流式响应
│   ├── serialize.ts   #   消息序列化（对话历史 → MiMo 格式）
│   ├── session.ts     #   会话管理（指纹匹配 & 上下文保持）
│   └── upload.ts      #   图片上传至小米 OSS
├── tools/             # Tool Calling 处理
│   ├── parser.ts      #   XML/JSON 工具调用解析
│   ├── format.ts      #   OpenAI/Anthropic 格式转换
│   └── prompt.ts      #   工具定义注入系统提示词
├── admin/             # 管理面板 & REST API
├── middleware/        # 认证、限流等中间件
├── config.ts          # 配置加载（数据库 → 内存）
├── db.ts              # SQLite 初始化
├── accounts.ts        # 多账号管理 & 负载均衡
├── api-keys.ts        # API 密钥管理
└── index.ts           # 入口
```

## 免责声明

本项目仅供学习和研究目的使用，与小米公司无任何关联。

使用前请阅读并遵守 [MiMo AI 服务条款](https://aistudio.xiaomimimo.com)。使用本项目可能导致账号限制，请自行承担风险。

请勿将本项目用于商业牟利、DDoS 攻击或大规模滥用等违规活动。作者不对因使用本项目导致的任何损失承担责任。

## License

ISC
