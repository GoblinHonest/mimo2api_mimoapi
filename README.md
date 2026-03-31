# MiMo Proxy

将小米 MiMo AI（aistudio.xiaomimimo.com）转换为兼容 OpenAI / Anthropic API 的代理服务。

## 功能特性

- 兼容 OpenAI `v1/chat/completions` 接口（支持流式 & 非流式）
- 兼容 Anthropic `v1/messages` 接口（支持流式 & 非流式）
- **图片理解**：支持 OpenAI `image_url` 和 Anthropic `image` 多模态内容块（自动上传至小米 OSS）
- 多账号负载均衡，自动选择最空闲账号
- 会话保持（Context Replay），减少 token 消耗
- Tool Calling 支持（函数调用）
- `<think>` 推理内容三种处理模式：保留 / 剥离 / 分离
- Web 管理界面 + REST 管理 API
- SQLite 持久化（账号、会话、请求日志）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 并按需修改：

```bash
cp .env.example .env
```

### 3. 启动服务

```bash
# 生产模式
npm start

# 开发模式（热重载）
npm run dev
```

服务默认监听 `http://localhost:8080`。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 监听端口 |
| `ADMIN_KEY` | `admin` | 管理 API 密钥，**务必修改** |
| `MAX_REPLAY_MESSAGES` | `20` | 会话回放消息数上限 |
| `MAX_QUERY_CHARS` | `12000` | 单次请求最大字符数 |
| `CONTEXT_RESET_THRESHOLD` | `80000` | 超过此 token 数时重置会话 |
| `MAX_CONCURRENT_PER_ACCOUNT` | `5` | 单账号最大并发请求数 |
| `THINK_MODE` | `passthrough` | 推理内容处理模式，见下文 |
| `SESSION_TTL_DAYS` | `7` | 会话保留天数 |

### THINK_MODE 说明

| 值 | 行为 |
|----|------|
| `passthrough` | 原样返回，包含 `<think>...</think>` 标签 |
| `strip` | 移除所有推理内容，只返回最终答案 |
| `separate` | 推理内容放入独立字段（Anthropic 格式下为 `thinking` block） |

## 添加账号

通过管理界面（`http://localhost:8080`）或 API 添加 MiMo 账号。

### 方式一：粘贴 cURL（推荐）

在浏览器 DevTools 中找到 `https://aistudio.xiaomimimo.com/open-apis/bot/chat` 请求，右键复制为 cURL，粘贴到管理界面。

### 方式二：手动填写

```bash
curl -X POST http://localhost:8080/admin/accounts \
  -H "X-Admin-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "service_token": "...",
    "user_id": "...",
    "ph_token": "...",
    "alias": "账号备注"
  }'
```

## API 使用

服务兼容 OpenAI 和 Anthropic 的接口，直接将 `base_url` 指向本服务即可。

### OpenAI 兼容

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <account-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

支持的模型：`mimo-v2-pro` / `mimo-v2-flash-studio` / `mimo-v2-omni`


### Anthropic 兼容

```bash
curl http://localhost:8080/v1/messages \
  -H "x-api-key: <account-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2-pro",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```


## 数据存储

数据默认保存在 `data.db`（SQLite），包含账号、会话上下文、请求日志。

## 免责声明 / Disclaimer

本项目仅供学习、研究和接口调试目的使用。

本项目并非小米 MiMo 官方项目，与小米 MiMo AI（aistudio.xiaomimimo.com）及其母公司小米（Xiaomi）没有任何关联。

本项目包含针对特定 API 协议的转换代码。在使用本项目前，请确保您已经仔细阅读并同意小米 MiMo AI 的服务条款（Terms of Service）。使用本项目可能引发账号封禁或其他限制。

请合理使用，勿将本项目用于任何商业牟利行为、DDoS 攻击或大规模高频并发滥用等非法违规活动。

作者及贡献者对任何人因使用本代码导致的任何损失、账号封禁或法律纠纷不承担任何直接或间接的责任。一切后果由使用者自行承担。

## License

ISC
