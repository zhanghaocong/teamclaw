# TeamClaw v0.0.1（OpenClaw Plugin 联动与设置）需求文档

> 范围说明：
> - v0.0.1 仍是 OpenClaw-first。
> - "多 Agent"在此定义为：同一个 OpenClaw 连接下可选择不同独立 agent（各自拥有独立 workspace、IDENTITY.md、SOUL.md、memory）执行。
> - 不涉及新增外部 provider（如 Claude 直连），仅限 OpenClaw 体系内多 agent。
> - 不使用 subagent 机制（subagent 无独立 workspace 和 soul）。

---

## 架构说明

TeamClaw 通过 **OpenClaw Channel Plugin**（`@teamclaw/openclaw-plugin`）与 OpenClaw 集成。插件运行在 OpenClaw Gateway 进程内部，定位为**无状态薄桥（stateless bridge）**——所有业务决策（选哪个 agent、是否允许执行、超时控制等）均由 TeamClaw Web 侧完成，插件只负责透传。

```
TeamClaw Web（Next.js）                          OpenClaw Gateway 进程
  ├── Frontend                                    ├── Agent "coder"   （独立 workspace）
  │   └── 用户选择 agent、触发 Run、审批            ├── Agent "reviewer" （独立 workspace）
  │                                                ├── Agent "writer"   （独立 workspace）
  └── API Routes                                   │
        │                                          └── @teamclaw/openclaw-plugin
        │  ① GET  /plugins/teamclaw/agents              │ （stateless bridge）
        │     ← 返回 agent 列表                          │
        │                                               │  内部只做：
        │  ② POST /plugins/teamclaw/runs                │  ├── 透传 agent_id → SDK dispatch
        │     { agent_id, goal, ... }                   │  ├── 透传 deliver() → callback
        │     → 插件按 agent_id 转发给对应 agent          │  └── 透传取消 → session abort
        │                                               │
        │  ③ POST {callbackUrl}/runs/:id/events    ←────┘  agent 回复后回调 TeamClaw
        │     ← 插件推送状态/结果
        │
        └── 业务逻辑（状态机、审批、权限、超时）全在这里
```

### 插件定位：Stateless Bridge

| 插件做的事 | 插件不做的事 |
|-----------|------------|
| 接收 TeamClaw 的 HTTP 请求 | 选择哪个 agent（TeamClaw 指定） |
| 按 `agent_id` 构造 sessionKey 并调用 SDK dispatch | 校验 agent 可用性（TeamClaw 自行判断） |
| 将 agent 回复通过 HTTP callback 推回 TeamClaw | 并发控制（TeamClaw 侧负责） |
| 枚举 agent 列表（透传 Gateway `agents.list`） | 超时计时（TeamClaw 侧负责） |
| 转发取消请求到 agent session | 状态机流转、审批逻辑、数据持久化 |

### 通信模型

| 方向 | 路径 | 机制 | 用途 |
|------|------|------|------|
| 插件 ↔ Agent | 进程内函数调用 | Plugin SDK `dispatchInboundReplyWithBase()` | 按 TeamClaw 指定的 agent_id 转发任务、收回复 |
| TeamClaw → 插件 | HTTP 请求 | `GET/POST/DELETE /plugins/teamclaw/*` | 提交 Run、拉 agent 列表、取消 Run |
| 插件 → TeamClaw | HTTP 回调 | `POST {callbackUrl}/...` | 推送 agent 回复/状态 |

### 插件内部实现（Plugin SDK Inbound Dispatch）

插件收到 TeamClaw 的请求后，**按调用方指定的 `agent_id` 直接构造 route**，调用 SDK 转发：

```typescript
// TeamClaw 请求: POST /plugins/teamclaw/runs
// { agent_id: "coder", card_id: "card-123", goal: "实现登录功能" }

// 插件只做一件事：按 agent_id 转发
const route = {
  agentId: request.agent_id,  // TeamClaw 指定，插件不做任何选择
  sessionKey: `agent:${request.agent_id}:teamclaw:direct:${request.card_id}`,
};

await dispatchInboundReplyWithBase({
  cfg, channel: "teamclaw", accountId, route,
  ctxPayload: { body: request.goal, from: request.card_id },
  deliver: (payload) => {
    // 将 agent 回复原样推送给 TeamClaw callback
    httpPost(callbackUrl, { event: "run.succeeded", data: payload });
  },
});
```

> 设计决策：
> - **插件不做路由决策**：不调用 `resolveAgentRoute()`，TeamClaw 传什么 `agent_id` 就转发给什么 agent。
> - **插件不做业务校验**：不校验 agent 是否可用、不检查并发、不管超时——这些全由 TeamClaw Web 侧处理。
> - **插件无状态**：不持久化任何 run/card 数据，仅在内存中维护活跃 dispatch 的引用（用于取消）。

---

## 0. Card 状态机

Card 在整个生命周期中遵循以下状态流转：

```
draft -> ready -> running -> review -> done
                    |          |
                    v          v
                  failed   changes_requested -> running（重跑）
```

| 状态 | 含义 | 可执行动作 |
|------|------|-----------|
| `draft` | 卡片草稿，目标/上下文尚未就绪 | 编辑、提交为 ready |
| `ready` | 就绪待执行 | 触发 Run、编辑 |
| `running` | Run 正在执行中 | 取消 Run |
| `review` | Run 成功，等待人工审批 | Approve / Changes Requested |
| `done` | 已审批通过，终态 | 无 |
| `failed` | Run 执行失败 | 重跑、编辑后重跑 |
| `changes_requested` | 审批驳回，等待重跑 | 修改后重跑、切换 Agent 重跑 |

- **AC-CARD-SM-001**：Card 状态流转必须严格遵循上述状态机，不允许跳跃转换（如 `draft` 直接到 `review`）。
- **AC-CARD-SM-002**：每次状态变更写入事件 `card.status_changed`（含 old_status / new_status）。
- **AC-CARD-SM-003**：`done` 是终态，进入后不可再触发 Run 或修改状态。

---

## A. 插件连接配置（Plugin Connection Setup）

> 连接由两侧各自配置：
> - **OpenClaw 侧**：安装插件，在 `openclaw.json` 中配置 TeamClaw 回调地址和密钥。
> - **TeamClaw 侧**：配置 OpenClaw Gateway 地址和共享密钥，用于向插件发起上行请求。

### A1. TeamClaw 侧配置项

- **AC-PLG-CONN-001**：系统提供 OpenClaw 配置页面，至少包含：
  - `gateway_url`（必填，OpenClaw Gateway 地址，如 `http://127.0.0.1:18789`）
  - `shared_secret`（必填，与插件侧约定的共享密钥，密文展示）
  - `default_agent_id`（可选）
- **AC-PLG-CONN-002**：保存配置后，`shared_secret` 不可明文回显（仅显示掩码）。
- **AC-PLG-CONN-003**：配置保存失败时返回明确错误（字段级）。

### A2. 连接测试

- **AC-PLG-CONN-004**：提供"测试连接"按钮，调用 `GET /plugins/teamclaw/health`。
- **AC-PLG-CONN-005**：连接测试成功时显示 `Connected`（含 Gateway 版本与可用 agent 数），失败时显示失败原因（如 401/timeout/ECONNREFUSED）。

### A3. 插件侧配置（文档说明，非 TeamClaw 代码实现）

- **AC-PLG-CONN-006**：提供插件安装与配置文档，说明 OpenClaw 侧需要：
  ```bash
  openclaw plugins install @teamclaw/openclaw-plugin
  ```
  并在 `openclaw.json` 中配置：
  ```json
  {
    "teamclaw": {
      "callbackUrl": "https://your-teamclaw.com/api/openclaw/callback",
      "sharedSecret": "xxx"
    }
  }
  ```
- **AC-PLG-CONN-007**：配置更新后新触发的 Run 使用最新配置；已在执行中的 Run 不受影响。
- **AC-PLG-CONN-008**：配置变更写入审计事件 `openclaw.config_updated`（不记录明文密钥）。

---

## B. Agent 列表与绑定

> TeamClaw Web 负责 agent 选择的所有业务逻辑。插件仅透传 Gateway 的 agent 列表。

### B1. 拉取 Agent 列表

- **AC-PLG-AGENT-001**：TeamClaw 通过 `GET /plugins/teamclaw/agents` 获取可用 agent 列表。
- **AC-PLG-AGENT-002**：插件透传 Gateway `agents.list` RPC 结果，返回字段包含：
  - `agent_id`（string，标识）
  - `name`（string，显示名）
  - `status`（string，`available` / `unavailable`）
- **AC-PLG-AGENT-003**：TeamClaw 侧缓存 agent 列表，TTL 为 10 分钟。超过 TTL 后首次访问自动触发后台刷新。
- **AC-PLG-AGENT-004**：拉取失败时 TeamClaw 保留上次缓存列表并提示"列表可能过期"。
- **AC-PLG-AGENT-005**：支持手动刷新 agent 列表。

### B2. Agent 选择（TeamClaw Web 侧逻辑）

- **AC-PLG-AGENT-006**：Workspace 支持设置 `default_agent_id`（可被 board/card 覆盖）。
- **AC-PLG-AGENT-007**：Board 支持设置 `default_agent_id`。
- **AC-PLG-AGENT-008**：Card 支持选择 `agent_id`；未设置时按优先级继承：`Card > Board > Workspace Default`。
- **AC-PLG-AGENT-009**：Card 的 `agent_id` 可在非 `running` 状态下修改；`running` 状态禁止修改。
- **AC-PLG-AGENT-010**：默认值变化时，不自动覆盖已显式设置的下层值。
- **AC-PLG-AGENT-011**：Board/Card 的 agent 变更写入事件（`board.default_agent_changed` / `card.agent_changed`，含 old/new）。
- **AC-PLG-AGENT-012**：触发 Run 时 TeamClaw 快照 `agent_id` 到 Run 记录，确保可追溯。

### B3. Agent 可用性校验（TeamClaw Web 侧逻辑）

- **AC-PLG-AGENT-013**：触发 Run 前，TeamClaw 根据缓存的 agent 列表校验 `agent_id` 是否 `available`。
- **AC-PLG-AGENT-014**：不可用时 Run 创建失败并返回 409，提示"agent {id} 不可用"。
- **AC-PLG-AGENT-015**：agent 被下线后，历史 Run 不受影响但新 Run 需阻止并提示。

---

## C. Run 执行链路

> TeamClaw Web 负责所有业务逻辑（并发控制、超时、状态流转）。插件只负责：收到请求 → 转发给 agent → 把结果推回来。

### C1. 并发控制（TeamClaw Web 侧逻辑）

- **AC-PLG-RUN-001**：同一 Card 同一时间只允许一个 active Run（状态为 `queued` 或 `running`）。重复提交返回 409 并提示"当前卡片已有运行中的任务"。

### C2. Run 提交（TeamClaw → 插件）

- **AC-PLG-RUN-002**：TeamClaw 通过 `POST /plugins/teamclaw/runs` 提交执行请求，请求体：
  ```json
  {
    "run_id": "uuid",
    "card_id": "card 标识",
    "agent_id": "目标 agent（TeamClaw 指定）",
    "goal": "任务目标描述",
    "context": "可选，背景信息（含历史审批意见等）",
    "correlation_id": "uuid（追踪标识）"
  }
  ```
- **AC-PLG-RUN-003**：插件收到后立即返回 `202 Accepted`（含 `session_key`），然后异步执行。
- **AC-PLG-RUN-004**：插件按 `agent_id` 构造 route 并调用 Plugin SDK 转发，不做任何业务校验。

### C3. Agent 回复（插件 → TeamClaw）

- **AC-PLG-RUN-005**：agent 处理完成后通过 `deliver()` 回调返回结果。插件将 agent 输出作为 `output_summary` 通过 HTTP callback 推送给 TeamClaw。
- **AC-PLG-RUN-006**：agent 执行失败时，插件推送 `run.failed` 事件，payload 包含 `error_message`。
- **AC-PLG-RUN-007**：插件通过 `events.onAgentEvent()` 监听中间状态（开始执行等），并推送 `run.status_changed` 事件。

### C4. 状态推送协议

- **AC-PLG-RUN-008**：Run 状态值：`queued / running / succeeded / failed / cancelled / timeout`。
- **AC-PLG-RUN-009**：插件通过 HTTP callback 推送事件到 `POST {callbackUrl}/runs/{run_id}/events`。
- **AC-PLG-RUN-010**：状态更新必须幂等——TeamClaw 基于状态机单向流转性忽略过时或重复的事件。
- **AC-PLG-RUN-011**：TeamClaw 收到回调后返回 `200 OK`；若返回非 2xx，插件以 30s/60s/120s 间隔重试，最多 3 次。

### C5. 结果处理（TeamClaw Web 侧逻辑）

- **AC-PLG-RUN-012**：TeamClaw 收到 `run.succeeded` 后保存 `output_summary`，卡片自动进入 `review`。
- **AC-PLG-RUN-013**：TeamClaw 收到 `run.failed` 后保存 `error_message`，卡片进入 `failed`。

### C6. 超时与取消

- **AC-PLG-RUN-014**：Run 超时默认值为 30 分钟，可在 Workspace 级别配置，允许范围 1~120 分钟。
- **AC-PLG-RUN-015**：超时计时由 TeamClaw 侧负责。超时后 TeamClaw 调用 `DELETE /plugins/teamclaw/runs/{run_id}`。
- **AC-PLG-RUN-016**：用户主动取消时，TeamClaw 同样调用 `DELETE /plugins/teamclaw/runs/{run_id}`。
- **AC-PLG-RUN-017**：插件收到取消请求后终止 agent dispatch，推送 `run.cancelled` 事件。
- **AC-PLG-RUN-018**：超时后 Run 标记为 `timeout`，卡片进入 `failed`。

### C7. 连接中断处理

- **AC-PLG-RUN-019**：若插件推送回调连续失败（TeamClaw 不可达），插件侧保留事件队列，恢复后按序重放。
- **AC-PLG-RUN-020**：若 TeamClaw 向插件发请求连续 3 次失败（Gateway 不可达），Run 标记为 `failed`，错误原因 `gateway_unreachable`，卡片进入 `failed`。

---

## D. 审批与重跑

### D1. Approve

- **AC-PLG-APR-001**：`approved` 后卡片进入 `done`，不得自动再触发 Run。
- **AC-PLG-APR-002**：审批记录需绑定具体 `run_id + agent_id`。

### D2. Changes Requested / Reject

- **AC-PLG-APR-003**：`changes_requested` 必须填写 comment，且长度 >= 5 字符。
- **AC-PLG-APR-004**：TeamClaw 将审批意见拼入下一轮 Run 的 `context` 字段发送给插件（agent 可见）。
- **AC-PLG-APR-005**：重跑默认沿用上一轮 `agent_id`，除非用户显式改 agent。
- **AC-PLG-APR-006**：重跑 Run 需保存 `rerun_of_run_id`，形成链路。

### D3. 跨 Agent 重跑

- **AC-PLG-APR-007**：用户可在重跑前切换为另一个独立 agent。
- **AC-PLG-APR-008**：切换 agent 后 sessionKey 变化（agentId 不同），新 agent 从空白上下文开始。
- **AC-PLG-APR-009**：切换后新 Run 的 `agent_id` 正确记录，历史 Run 不变。

---

## E. OpenClaw 设置页面交互

### E1. 页面信息结构

- **AC-PLG-SET-001**：设置页包含三个区块：
  1) Plugin Connection（gateway_url / shared_secret / 连接状态指示灯）
  2) Agent Catalog（可用独立 agent 列表，来自插件透传）
  3) Defaults（默认 agent、默认超时）
- **AC-PLG-SET-002**：Agent 列表支持按 name/id 搜索过滤。
- **AC-PLG-SET-003**：每个 agent 显示：name、agent_id、status（available/unavailable）。

---

## F. 安全与权限

### F1. 通信安全

- **AC-PLG-SEC-001**：插件与 TeamClaw 之间的 HTTP 通信使用 `shared_secret` 做 HMAC-SHA256 签名校验（双向）。
- **AC-PLG-SEC-002**：TeamClaw 向插件发请求时在 `Authorization` header 中携带签名；插件回调 TeamClaw 时同样携带签名。
- **AC-PLG-SEC-003**：签名校验失败时返回 401，并记录安全事件。
- **AC-PLG-SEC-004**：审计日志不记录敏感字段（shared_secret/token）。

### F2. 基础权限模型

- **AC-PLG-SEC-005**：v0.0.1 定义两个角色：`admin`（可管理连接配置与默认策略）和 `member`（可操作 Board/Card/Run/审批）。
- **AC-PLG-SEC-006**：插件连接配置（Section A）仅 `admin` 可修改。
- **AC-PLG-SEC-007**：Approve / Changes Requested 操作仅 `member` 及以上角色可执行，且不可审批自己触发的 Run。

---

## G. 观测与可运维性

- **AC-PLG-OBS-001**：TeamClaw 侧记录每次插件交互：方向（上行/下行）、路由、run_id、agent_id、耗时、结果状态、correlation_id。
- **AC-PLG-OBS-002**：单个 Run 支持追踪完整链路（提交 → 插件转发 → agent 执行 → 结果推送 → 审批）。

---

## H. 兼容与降级

- **AC-PLG-FB-001**：Gateway 不可用时，TeamClaw 阻止新 Run 并提示"OpenClaw 连接中断"。
- **AC-PLG-FB-002**：Gateway 不可用不影响历史数据浏览（runs/events 可读）。
- **AC-PLG-FB-003**：Agent 列表拉取失败时仍可使用缓存中的 agent 列表（若存在）。
- **AC-PLG-FB-004**：插件回调 TeamClaw 失败时的重试机制（见 AC-PLG-RUN-011）确保事件不丢失。

---

## I. 插件协议（Plugin Contract）

> 插件是无状态薄桥。本节定义插件的最小实现范围和双方 HTTP 接口契约。

### I1. 插件最小实现范围

插件只需实现以下能力：

| 能力 | 实现方式 | 说明 |
|------|---------|------|
| 暴露 HTTP 路由 | `api.registerChannel()` + plugin HTTP routes | 接收 TeamClaw 的上行请求 |
| 透传 agent 列表 | 调用 Gateway `agents.list` RPC → 返回 JSON | 不做过滤或加工 |
| 按指定 agent_id 转发消息 | 构造 route → `dispatchInboundReplyWithBase()` | agent_id 由调用方指定 |
| 推送结果 | `deliver()` 回调 → HTTP POST callbackUrl | 将 agent 回复原样推回 |
| 转发取消 | 终止活跃 dispatch | 内存中维护 run_id → dispatch 映射 |
| 读取插件配置 | `api.runtime.loadConfig()` | 获取 callbackUrl / sharedSecret |

**插件不需要实现**：状态机、并发控制、超时计时、agent 可用性校验、数据持久化、权限检查。

### I2. 插件侧 HTTP 路由（TeamClaw → 插件，上行）

通过 OpenClaw Gateway 的 `/plugins/teamclaw/*` 路径访问：

| 方法 | 路由 | 用途 | 请求体 | 响应 |
|------|------|------|-------|------|
| `GET` | `/plugins/teamclaw/health` | 健康检查 | — | `200 { "status": "ok", "version": "..." }` |
| `GET` | `/plugins/teamclaw/agents` | 透传 agent 列表 | — | `200 { "agents": [{ "agent_id", "name", "status" }] }` |
| `POST` | `/plugins/teamclaw/runs` | 转发 Run 到指定 agent | 见 AC-PLG-RUN-002 | `202 { "session_key": "..." }` |
| `DELETE` | `/plugins/teamclaw/runs/:run_id` | 转发取消请求 | — | `200 { "cancelled": true }` |

所有请求需携带 `Authorization: HMAC-SHA256 <signature>` header。

### I3. TeamClaw 侧回调路由（插件 → TeamClaw，下行）

| 方法 | 路由 | 用途 | 响应 |
|------|------|------|------|
| `POST` | `/api/openclaw/callback/runs/:run_id/events` | 推送 agent 回复/状态 | `200 OK` |

事件 payload 格式：

```json
{
  "event": "run.status_changed | run.succeeded | run.failed | run.cancelled",
  "run_id": "uuid",
  "agent_id": "agent 标识（原样回传）",
  "correlation_id": "uuid（原样回传）",
  "timestamp": "ISO8601",
  "data": {
    "status": "queued | running | succeeded | failed | cancelled",
    "output_summary": "agent 输出文本（仅 succeeded）",
    "error_message": "错误信息（仅 failed）"
  }
}
```

回调请求需携带 `Authorization: HMAC-SHA256 <signature>` header。

### I4. Session 设计

- **AC-PLG-PROTO-001**：sessionKey 格式为 `agent:{agentId}:teamclaw:direct:{cardId}`，由插件按调用方传入的 `agent_id` 和 `card_id` 拼接。
- **AC-PLG-PROTO-002**：同一 Card 使用相同 agent 的多次 Run 复用 sessionKey，agent 可访问历史上下文。
- **AC-PLG-PROTO-003**：切换 agent 后 sessionKey 变化（agentId 不同），新 agent 从空白上下文开始。
- **AC-PLG-PROTO-004**：审批意见由 TeamClaw 拼入 `context` 字段随 Run 请求发送，插件将其作为消息内容的一部分转发给 agent。

---

## J. E2E 场景

- **AC-PLG-E2E-001**：安装插件 → 配置双向连接 → 测试连接成功 → 拉取 agent 列表 → 设置 Board 默认 agent → 新卡片执行成功。
- **AC-PLG-E2E-002**：卡片 override agent → Run 成功 → Approve → Done。
- **AC-PLG-E2E-003**：Run 成功 → Reject(comment) → 同 agent 重跑（agent 可见审批意见） → Approve。
- **AC-PLG-E2E-004**：Run 成功 → Reject → 切换另一个 agent 重跑（新 session） → Approve。
- **AC-PLG-E2E-005**：agent 下线后新 Run 被阻止且提示明确；历史 Run 可正常查看。
- **AC-PLG-E2E-006**：同一 Card 重复提交 Run 被拦截，返回 409。
- **AC-PLG-E2E-007**：Run 超时后卡片进入 `failed`，可修改后重跑。
- **AC-PLG-E2E-008**：Gateway 临时不可达 → 新 Run 阻止 → Gateway 恢复后正常执行。
- **AC-PLG-E2E-009**：Run 执行中 TeamClaw 短暂重启 → 插件重试回调 → 状态最终一致。

---

## 变更记录

| 变更 | 说明 |
|------|------|
| 架构重构 | 从"TeamClaw 直连 OpenClaw API"改为"通过 Channel Plugin 集成" |
| 插件定位明确 | 插件为 stateless bridge，所有业务决策在 TeamClaw Web 侧 |
| 交互机制确定 | 插件使用 Plugin SDK Inbound Dispatch，按 TeamClaw 指定的 agent_id 直接转发 |
| 独立 Agent 明确 | 所有 agent 为独立 agent（独立 workspace/IDENTITY.md/SOUL.md/memory），非 subagent |
| 职责重新划分 | agent 选择、可用性校验、并发控制、超时计时等逻辑全部移至 TeamClaw Web 侧 |
| Section B 重构 | 拆为"拉取列表"（插件透传）+"Agent 选择"（Web 侧逻辑）+"可用性校验"（Web 侧逻辑） |
| Section C 精简 | 插件侧 AC 大幅减少，仅保留转发/推送相关；业务 AC 明确标注为 Web 侧逻辑 |
| Section I 精简 | 新增"插件最小实现范围"表，明确插件做什么、不做什么；删除 agent 可用性校验路由 |
| AC 编号全局重排 | 反映职责重新划分后的 AC 拆分 |
