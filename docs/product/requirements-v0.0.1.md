# TeamClaw v0.0.1 需求文档

> **TeamClaw** 是一个面向 Claw 生态的项目任务管理插件。它可以安装到任何兼容 Claw Plugin SDK 的宿主应用中（如 OpenClaw 及其衍生项目），为用户提供 Kanban 式的 Agent 任务编排、执行与审批工作流。

> 范围说明：
> - v0.0.1 基于 Claw Plugin SDK 实现，可运行在任何兼容宿主中。
> - "多 Agent"在此定义为：同一宿主下可选择不同独立 agent（各自拥有独立 workspace、IDENTITY.md、SOUL.md、memory）执行任务。
> - 不使用 subagent 机制（subagent 无独立 workspace 和 soul）。

---

## 架构说明

TeamClaw 作为一个 **Claw Channel Plugin**（`@teamclaw/claw-plugin`）运行在宿主应用的 Gateway 进程内部。插件同时承载前端 SPA、后端 API、数据持久化和 Agent 交互，用户只需安装插件即可使用。

### 代码分层（Ports & Adapters）

插件内部采用 **端口与适配器** 架构，将宿主 SDK 依赖隔离在适配器层，核心业务逻辑不依赖任何宿主特定包：

```
@teamclaw/claw-plugin
│
├── src/index.ts                         ← 插件入口（胶水层）
│     注册 HTTP routes，接线 adapter → core
│
├── src/adapter/                         ← 宿主适配器（可替换）
│     └── claw-provider.ts                  实现 AgentProvider 接口
│           ├── agents.list RPC             → listAgents()
│           ├── dispatchInboundReplyWithBase → dispatch()
│           └── deliver() 回调               → onResult callback
│
├── src/core/                            ← 纯业务逻辑（不 import 任何宿主包）
│     ├── ports.ts                          AgentProvider / Database 接口定义
│     ├── state-machine.ts                  Card 状态机
│     ├── run-service.ts                    Run 编排（并发控制、超时、取消）
│     ├── approval-service.ts               审批流
│     └── board-service.ts                  Board / Card CRUD
│
├── src/api/                             ← HTTP route handlers
│     └── routes.ts                         调用 core services，不直接调用 SDK
│
├── src/db/                              ← SQLite 持久化
│     └── schema.ts                         实现 Database 接口
│
└── src/web/                             ← SPA 构建产物（Vite + React）
      └── dist/                             打包进 npm 包
```

**依赖方向（严格单向）**：

```
index.ts → adapter/ → claw/plugin-sdk（宿主 SDK）
               ↓
index.ts → api/ → core/ → ports.ts（接口定义）
                    ↓
                   db/
```

- `core/` 只依赖 `ports.ts` 中定义的接口，不依赖 `adapter/` 或任何宿主包。
- `adapter/` 是唯一 import 宿主 SDK 的地方。
- 替换 adapter 即可适配不同的 Claw 兼容宿主，core 层零改动。

### 核心接口（ports.ts）

```typescript
// core/ports.ts — 纯 TypeScript，不依赖任何宿主包

export interface AgentProvider {
  listAgents(): Promise<Agent[]>
  dispatch(params: {
    agentId: string
    sessionKey: string
    goal: string
    context?: string
  }): Promise<DispatchHandle>
  cancel(handle: DispatchHandle): Promise<void>
}

export interface Agent {
  agent_id: string
  name: string
  status: "available" | "unavailable"
}

export interface DispatchHandle {
  runId: string
  onResult: (cb: (result: TaskResult) => void) => void
}

export interface TaskResult {
  success: boolean
  output_summary?: string
  error_message?: string
}
```

### 单一部署

```bash
# 以 OpenClaw 为例——任何兼容宿主均可
openclaw plugins install @teamclaw/claw-plugin

# 打开浏览器访问
open http://127.0.0.1:18789/plugins/teamclaw/
```

### 技术选型

| 层 | 选型 | 说明 |
|---|------|------|
| 前端 | Vite + React + TypeScript + Tailwind CSS | SPA，构建产物打包进插件 npm 包 |
| API | 插件 HTTP route handlers | 注册在 `/plugins/teamclaw/api/*` |
| 数据库 | SQLite（better-sqlite3） | 存储于 `api.runtime.resolveStateDir()` |
| Agent 交互 | Claw Plugin SDK Inbound Dispatch | 隔离在 `adapter/` 层，core 通过 `AgentProvider` 接口调用 |

### 内部通信模型

所有通信在同一进程内完成，无跨服务网络调用：

```
用户浏览器
  ↕ HTTP
宿主 Gateway 进程
  ├── 插件 HTTP routes（api/）
  │     ↕ 函数调用
  ├── 业务逻辑（core/）── 依赖 AgentProvider 接口
  │     ↕ 函数调用             ↕ 接口调用
  ├── 数据持久化（db/）    宿主适配器（adapter/）
  │                           ↕ Plugin SDK
  └──────────────────── Agent Runtime
```

### 宿主兼容性

TeamClaw 兼容任何实现了 Claw Plugin SDK 的宿主应用，包括但不限于：

| 宿主 | 安装命令 | 说明 |
|------|---------|------|
| OpenClaw | `openclaw plugins install @teamclaw/claw-plugin` | 主要开发/测试目标 |
| 其他 Claw 兼容应用 | `<host> plugins install @teamclaw/claw-plugin` | 遵循相同 Plugin SDK 即可 |

插件依赖的宿主能力：
- `api.registerChannel()` — 注册 channel 并暴露 HTTP 路由
- `agents.list` Gateway RPC — 枚举独立 agent
- `dispatchInboundReplyWithBase()` — 向指定 agent 分发消息
- `api.runtime.resolveStateDir()` — 获取持久化存储路径

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

## A. 安装与配置

> 用户只需在宿主应用中安装插件并打开浏览器。

### A1. 安装

- **AC-SETUP-001**：用户通过宿主的插件安装命令安装 `@teamclaw/claw-plugin`。
- **AC-SETUP-002**：安装后插件自动注册 HTTP 路由，用户通过 `http://{gateway_host}/plugins/teamclaw/` 访问 Web UI。
- **AC-SETUP-003**：首次访问时，插件自动初始化 SQLite 数据库（创建表结构），存储于 `api.runtime.resolveStateDir("teamclaw")` 目录下。

### A2. 插件配置

- **AC-SETUP-004**：插件通过 `openclaw.plugin.json` 的 `configSchema` 定义可选配置项：
  - `defaultTimeout`（可选，Run 超时分钟数，默认 30，范围 1~120）
- **AC-SETUP-005**：配置变更写入审计事件 `teamclaw.config_updated`。

---

## B. Agent 列表与选择

> 插件通过 `AgentProvider` 接口获取宿主管理的独立 agent 列表。

### B1. 获取 Agent 列表

- **AC-AGENT-001**：前端通过 `GET /plugins/teamclaw/api/agents` 获取可用 agent 列表。
- **AC-AGENT-002**：API 层调用 `AgentProvider.listAgents()`（adapter 内部调用宿主 `agents.list` RPC），返回字段包含：
  - `agent_id`（string，标识）
  - `name`（string，显示名）
  - `status`（string，`available` / `unavailable`）
- **AC-AGENT-003**：adapter 层缓存 agent 列表，TTL 为 10 分钟。超过 TTL 后首次请求自动刷新。
- **AC-AGENT-004**：`AgentProvider.listAgents()` 调用失败时返回上次缓存列表并在响应中标记 `stale: true`。
- **AC-AGENT-005**：前端支持手动刷新（`GET /plugins/teamclaw/api/agents?refresh=true` 强制刷新缓存）。

### B2. Agent 选择

- **AC-AGENT-006**：Workspace 支持设置 `default_agent_id`（可被 board/card 覆盖）。
- **AC-AGENT-007**：Board 支持设置 `default_agent_id`。
- **AC-AGENT-008**：Card 支持选择 `agent_id`；未设置时按优先级继承：`Card > Board > Workspace Default`。
- **AC-AGENT-009**：Card 的 `agent_id` 可在非 `running` 状态下修改；`running` 状态禁止修改。
- **AC-AGENT-010**：默认值变化时，不自动覆盖已显式设置的下层值。
- **AC-AGENT-011**：Board/Card 的 agent 变更写入事件（`board.default_agent_changed` / `card.agent_changed`，含 old/new）。
- **AC-AGENT-012**：触发 Run 时快照 `agent_id` 到 Run 记录，确保可追溯。

### B3. Agent 可用性校验

- **AC-AGENT-013**：触发 Run 前，根据缓存的 agent 列表校验 `agent_id` 是否 `available`。
- **AC-AGENT-014**：不可用时 Run 创建失败并返回 409，提示"agent {id} 不可用"。
- **AC-AGENT-015**：agent 被下线后，历史 Run 不受影响但新 Run 需阻止并提示。

---

## C. Run 执行链路

> Run 的全部生命周期在插件进程内完成：前端发起 → API 层校验 → AgentProvider dispatch → agent 回复 → 写入数据库 → 前端轮询获取结果。

### C1. 并发控制

- **AC-RUN-001**：同一 Card 同一时间只允许一个 active Run（状态为 `queued` 或 `running`）。重复提交返回 409。

### C2. Run 提交

- **AC-RUN-002**：前端通过 `POST /plugins/teamclaw/api/runs` 提交执行请求，请求体：
  ```json
  {
    "card_id": "card 标识",
    "agent_id": "目标 agent（用户指定）",
    "goal": "任务目标描述",
    "context": "可选，背景信息"
  }
  ```
- **AC-RUN-003**：API 层生成 `run_id`（UUID），校验并发控制（AC-RUN-001）和 agent 可用性（AC-AGENT-013），通过后写入数据库（状态 `queued`），卡片进入 `running`，立即返回 `201 { "run_id": "..." }`。
- **AC-RUN-004**：API 层异步调用 `AgentProvider.dispatch()`，由 adapter 层负责构造宿主特定的 route 并调用 SDK：
  ```typescript
  // core/run-service.ts — 只依赖 AgentProvider 接口
  const handle = await provider.dispatch({
    agentId: run.agent_id,
    sessionKey: `agent:${run.agent_id}:teamclaw:direct:${run.card_id}`,
    goal: run.goal,
    context: run.context,
  });
  handle.onResult((result) => { /* 更新数据库 */ });
  ```

### C3. Agent 回复处理

- **AC-RUN-005**：agent 处理完成后，`AgentProvider` 通过 `DispatchHandle.onResult()` 回调返回 `TaskResult`。core 层从中提取输出文本，更新数据库：Run 状态 → `succeeded`，保存 `output_summary`。
- **AC-RUN-006**：agent 执行失败时，`TaskResult.success` 为 `false`，core 层更新数据库：Run 状态 → `failed`，保存 `error_message`。
- **AC-RUN-007**：Run 成功后卡片自动进入 `review`，记录 `run.succeeded` 事件。
- **AC-RUN-008**：Run 失败后卡片进入 `failed`，记录 `run.failed` 事件。

### C4. 前端状态获取

- **AC-RUN-009**：前端通过 `GET /plugins/teamclaw/api/runs/{run_id}` 轮询 Run 状态。
- **AC-RUN-010**：Run 状态值：`queued / running / succeeded / failed / cancelled / timeout`。
- **AC-RUN-011**：轮询间隔建议 3 秒，Run 进入终态后停止轮询。

### C5. 超时与取消

- **AC-RUN-012**：Run 超时默认值为 30 分钟，可在插件配置中调整，范围 1~120 分钟。
- **AC-RUN-013**：超时检测由 core 层 `RunService` 负责（dispatch 时设置定时器）。超时后调用 `AgentProvider.cancel(handle)`，更新 Run 状态 → `timeout`，卡片进入 `failed`。
- **AC-RUN-014**：用户主动取消时，前端调用 `DELETE /plugins/teamclaw/api/runs/{run_id}`，core 层调用 `AgentProvider.cancel(handle)`，更新 Run 状态 → `cancelled`。
- **AC-RUN-015**：取消/超时事件写入审计日志。

### C6. Session 设计

- **AC-RUN-016**：sessionKey 格式为 `agent:{agentId}:teamclaw:direct:{cardId}`。
- **AC-RUN-017**：同一 Card 使用相同 agent 的多次 Run 复用 sessionKey，agent 可访问历史上下文。
- **AC-RUN-018**：切换 agent 后 sessionKey 变化（agentId 不同），新 agent 从空白上下文开始。
- **AC-RUN-019**：重跑时审批意见作为 `context` 的一部分发送，追加到 session 中，agent 可见前序反馈。

---

## D. 审批与重跑

### D1. Approve

- **AC-APR-001**：`approved` 后卡片进入 `done`，不得自动再触发 Run。
- **AC-APR-002**：审批记录需绑定具体 `run_id + agent_id`，写入数据库。

### D2. Changes Requested / Reject

- **AC-APR-003**：`changes_requested` 必须填写 comment，且长度 >= 5 字符。
- **AC-APR-004**：审批意见保存到数据库，下一轮 Run 提交时拼入 `context` 字段（agent 可见）。
- **AC-APR-005**：重跑默认沿用上一轮 `agent_id`，除非用户显式改 agent。
- **AC-APR-006**：重跑 Run 需保存 `rerun_of_run_id`，形成链路。

### D3. 跨 Agent 重跑

- **AC-APR-007**：用户可在重跑前切换为另一个独立 agent。
- **AC-APR-008**：切换 agent 后 sessionKey 变化，新 agent 从空白上下文开始。
- **AC-APR-009**：切换后新 Run 的 `agent_id` 正确记录，历史 Run 不变。

---

## E. 设置页面

### E1. 页面信息结构

- **AC-SET-001**：设置页包含两个区块：
  1) Agent Catalog（可用独立 agent 列表，实时从宿主获取）
  2) Defaults（默认 agent、默认超时）
- **AC-SET-002**：Agent 列表支持按 name/id 搜索过滤。
- **AC-SET-003**：每个 agent 显示：name、agent_id、status（available/unavailable）。

---

## F. 安全与权限

### F1. 访问控制

- **AC-SEC-001**：Web UI 的访问控制复用宿主 Gateway 的认证机制。
- **AC-SEC-002**：若宿主未启用认证（本地开发场景），插件允许匿名访问。
- **AC-SEC-003**：审计日志不记录敏感字段。

### F2. 基础权限模型

- **AC-SEC-004**：v0.0.1 定义两个角色：`admin`（可管理默认策略）和 `member`（可操作 Board/Card/Run/审批）。
- **AC-SEC-005**：Approve / Changes Requested 操作仅 `member` 及以上角色可执行，且不可审批自己触发的 Run。

---

## G. 观测与可运维性

- **AC-OBS-001**：每次 agent dispatch 记录：run_id、agent_id、耗时、结果状态。
- **AC-OBS-002**：单个 Run 支持追踪完整链路（提交 → dispatch → agent 执行 → 回复 → 状态更新 → 审批）。
- **AC-OBS-003**：所有事件通过 `events` 表持久化，前端可查询事件时间线。

---

## H. 兼容与降级

- **AC-FB-001**：Agent Runtime 异常时（dispatch 失败），Run 标记为 `failed`，错误原因记录。
- **AC-FB-002**：Agent 列表获取失败时返回缓存列表（若存在）。
- **AC-FB-003**：SQLite 数据库异常时 API 返回 500，前端显示错误提示。

---

## I. 数据模型（SQLite）

> 插件使用 SQLite 持久化所有业务数据，存储于宿主状态目录。

### I1. 核心表

| 表 | 主要字段 | 说明 |
|---|---------|------|
| `workspaces` | id, default_agent_id, default_timeout, created_at | 工作空间配置 |
| `boards` | id, workspace_id, name, default_agent_id, created_at | 看板 |
| `cards` | id, board_id, status, agent_id, goal, context, created_at, updated_at | 卡片 |
| `runs` | id, card_id, agent_id, status, goal, context, output_summary, error_message, session_key, rerun_of_run_id, started_at, finished_at | 执行记录 |
| `approvals` | id, run_id, agent_id, decision, comment, created_by, created_at | 审批记录 |
| `events` | id, entity_type, entity_id, event_type, payload, created_at | 审计事件 |

### I2. 数据完整性

- **AC-DATA-001**：所有表使用外键约束，删除 Board 时级联删除其下 Card/Run/Approval/Event。
- **AC-DATA-002**：Run 的 `agent_id` 为创建时的快照值，不随 Card 的 agent_id 变更而变化。
- **AC-DATA-003**：Event 表为追加写入，不可修改或删除。

---

## J. API 路由汇总

> 所有路由注册在 `/plugins/teamclaw/` 下。

### J1. 静态资源

| 路由 | 说明 |
|------|------|
| `GET /plugins/teamclaw/` | SPA 入口（index.html） |
| `GET /plugins/teamclaw/assets/*` | SPA 静态资源（JS/CSS） |

### J2. API 路由

| 方法 | 路由 | 说明 |
|------|------|------|
| `GET` | `/plugins/teamclaw/api/agents` | 获取 agent 列表（通过 AgentProvider） |
| `GET` | `/plugins/teamclaw/api/boards` | 列出所有 Board |
| `POST` | `/plugins/teamclaw/api/boards` | 创建 Board |
| `PATCH` | `/plugins/teamclaw/api/boards/:id` | 更新 Board（含 default_agent_id） |
| `DELETE` | `/plugins/teamclaw/api/boards/:id` | 删除 Board |
| `GET` | `/plugins/teamclaw/api/boards/:id/cards` | 列出 Board 下的 Card |
| `POST` | `/plugins/teamclaw/api/cards` | 创建 Card |
| `PATCH` | `/plugins/teamclaw/api/cards/:id` | 更新 Card（含 agent_id、status） |
| `GET` | `/plugins/teamclaw/api/cards/:id` | 获取 Card 详情（含 runs） |
| `POST` | `/plugins/teamclaw/api/runs` | 提交 Run（触发 agent dispatch） |
| `GET` | `/plugins/teamclaw/api/runs/:id` | 获取 Run 状态/结果（前端轮询） |
| `DELETE` | `/plugins/teamclaw/api/runs/:id` | 取消 Run |
| `POST` | `/plugins/teamclaw/api/runs/:id/approve` | 审批通过 |
| `POST` | `/plugins/teamclaw/api/runs/:id/reject` | 审批驳回（含 comment） |
| `GET` | `/plugins/teamclaw/api/cards/:id/events` | 查询 Card 事件时间线 |
| `GET` | `/plugins/teamclaw/api/settings` | 获取 Workspace 设置 |
| `PATCH` | `/plugins/teamclaw/api/settings` | 更新 Workspace 设置 |

---

## K. E2E 场景

- **AC-E2E-001**：安装插件 → 打开 Web UI → 看到 agent 列表 → 创建 Board（设默认 agent） → 创建 Card → 触发 Run → 成功 → Approve → Done。
- **AC-E2E-002**：Card override agent → Run 成功 → Approve → Done。
- **AC-E2E-003**：Run 成功 → Reject(comment) → 同 agent 重跑（agent 可见审批意见） → Approve。
- **AC-E2E-004**：Run 成功 → Reject → 切换另一个 agent 重跑（新 session） → Approve。
- **AC-E2E-005**：agent 下线后新 Run 被阻止且提示明确；历史 Run 可正常查看。
- **AC-E2E-006**：同一 Card 重复提交 Run 被拦截，返回 409。
- **AC-E2E-007**：Run 超时后卡片进入 `failed`，可修改后重跑。

---

## 变更记录

| 变更 | 说明 |
|------|------|
| 产品定位重定义 | 从"OpenClaw 专用插件"改为"Claw 生态通用任务管理插件"，可安装到任何兼容宿主 |
| 包名变更 | `@teamclaw/openclaw-plugin` → `@teamclaw/claw-plugin` |
| 术语泛化 | "OpenClaw" → "宿主（host）"或 "Claw 生态"；保留具体 SDK 引用时使用 "Claw Plugin SDK" |
| 新增宿主兼容性说明 | 列出插件依赖的最小宿主能力集（4 项 SDK 能力） |
| 架构重构（B 方案） | 全栈插件——SPA/API/数据库全部运行在插件内 |
| 代码分层（Ports & Adapters） | `AgentProvider` 接口隔离宿主 SDK 依赖；core 层纯业务逻辑不依赖任何宿主包 |
| 技术栈 | Vite + React SPA；插件安装一步完成 |
