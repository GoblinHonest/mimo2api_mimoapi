# 会话管理流程测试

## 场景1：正常对话流程（修复后）

### 第1次请求
- 输入：无会话标识
- 处理：
  - `effectiveSessionKey = null`
  - 生成 `conversationId = "abc123"`
  - `effectiveClientSessionId = "abc123"`
  - 创建会话：
    ```
    id: "uuid-1"
    client_session_id: "abc123"
    conversation_id: "abc123"
    cumulative_prompt_tokens: 100
    ```
- 响应：编码 `"abc123"` 到零宽字符

### 第2次请求
- 输入：消息中包含零宽字符 `"abc123"`
- 处理：
  - `embeddedSessionId = "abc123"`
  - `effectiveSessionKey = "abc123"`
  - 查找会话：找到 `uuid-1`
  - `effectiveClientSessionId = session.client_session_id = "abc123"`
  - `conversationId = session.conversation_id = "abc123"`
  - 更新 token：`cumulative_prompt_tokens = 200`
- 响应：编码 `"abc123"` 到零宽字符 ✓

### 第3次请求（token超限）
- 输入：消息中包含零宽字符 `"abc123"`
- 处理：
  - `embeddedSessionId = "abc123"`
  - `effectiveSessionKey = "abc123"`
  - 查找会话：找到 `uuid-1`，但 `cumulative_prompt_tokens > threshold`
  - 过期旧会话：`UPDATE sessions SET is_expired = 1 WHERE id = 'uuid-1'`
  - 创建新会话：
    ```
    id: "uuid-2"
    client_session_id: "abc123"  ← 保持不变
    conversation_id: "xyz789"    ← 新生成
    cumulative_prompt_tokens: 150
    ```
  - `effectiveClientSessionId = session.client_session_id = "abc123"` ✓
  - `conversationId = "xyz789"`
- 响应：编码 `"abc123"` 到零宽字符 ✓

### 第4次请求
- 输入：消息中包含零宽字符 `"abc123"`
- 处理：
  - `embeddedSessionId = "abc123"`
  - `effectiveSessionKey = "abc123"`
  - 查找会话：找到 `uuid-2` ✓
  - `effectiveClientSessionId = "abc123"` ✓
  - `conversationId = "xyz789"` ✓
- 响应：编码 `"abc123"` 到零宽字符 ✓

## 场景2：原始代码的问题（修复前）

### 第3次请求（token超限）
- 响应：编码 `"xyz789"` 到零宽字符 ✗

### 第4次请求
- 输入：消息中包含零宽字符 `"xyz789"`
- 处理：
  - `embeddedSessionId = "xyz789"`
  - `effectiveSessionKey = "xyz789"`
  - 查找会话：`WHERE client_session_id = "xyz789"` ✗ **找不到！**
  - 数据库中只有 `client_session_id = "abc123"` 的记录
  - 创建新会话：
    ```
    id: "uuid-3"
    client_session_id: "xyz789"  ← 新的key
    conversation_id: "def456"    ← 又一个新ID
    ```
- 响应：编码 `"def456"` 到零宽字符 ✗

### 第5次请求
- 输入：消息中包含零宽字符 `"def456"`
- 查找：`WHERE client_session_id = "def456"` ✗ **又找不到！**
- 无限循环创建新会话...

## 数据库状态对比

### 修复后（正常）
```
id      | client_session_id | conversation_id | is_expired | tokens
--------|-------------------|-----------------|------------|-------
uuid-1  | abc123           | abc123          | 1          | 5000
uuid-2  | abc123           | xyz789          | 0          | 150
```
同一个 `client_session_id` 可以有多条记录（旧的过期，新的活跃）

### 修复前（问题）
```
id      | client_session_id | conversation_id | is_expired | tokens
--------|-------------------|-----------------|------------|-------
uuid-1  | abc123           | abc123          | 1          | 5000
uuid-2  | abc123           | xyz789          | 1          | 5000
uuid-3  | xyz789           | def456          | 1          | 5000
uuid-4  | def456           | ghi789          | 0          | 150
```
每次都创建新的 `client_session_id`，无法复用会话

## 结论

修复的核心：
- ✓ 编码 `client_session_id`（稳定的客户端标识）
- ✗ 编码 `conversation_id`（可能变化的MiMo对话ID）

这样确保了即使内部的 `conversation_id` 因为重置而变化，客户端仍然能通过相同的 `client_session_id` 找到正确的会话。
