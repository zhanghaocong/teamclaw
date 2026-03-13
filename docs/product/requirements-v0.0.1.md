# TeamClaw v0.0.1（OpenClaw 联动与设置）AC 细化

> 范围说明：  
> - v0.0.1 仍是 OpenClaw-first。  
> - “多 Agent”在此定义为：同一个 OpenClaw 连接下可选择不同 agent profile/agent_id 执行。  
> - 不涉及新增外部 provider（如 Claude 直连），仅限 OpenClaw 体系内多 agent。

---

## A. OpenClaw 连接配置（Connection Setup）

### A1. 基础配置项
- **AC-OC-CONN-001**：系统提供 OpenClaw 配置页面，至少包含：
  - `endpoint`（必填，URL）
  - `api_key`（必填，密文展示）
  - `workspace_id`（可选，若 OpenClaw 侧需要）
  - `default_agent_id`（可选）
- **AC-OC-CONN-002**：保存配置后，`api_key` 不可明文回显（仅显示掩码）。
- **AC-OC-CONN-003**：配置保存失败时返回明确错误（字段级）。

### A2. 连接测试
- **AC-OC-CONN-004**：提供“测试连接”按钮，调用 OpenClaw 健康检查或轻量接口。
- **AC-OC-CONN-005**：连接测试成功时显示 `Connected`，失败时显示失败原因（如 401/timeout）。
- **AC-OC-CONN-006**：连接测试结果写入事件 `openclaw.connection_tested`。

### A3. 配置生效与版本
- **AC-OC-CONN-007**：配置更新后新触发的 Run 使用最新配置；已在执行中的 Run 不受影响。
- **AC-OC-CONN-008**：配置变更写入审计事件 `openclaw.config_updated`（不记录明文密钥）。

---

## B. OpenClaw Agent 列表与绑定（多 Agent in OpenClaw）

### B1. 拉取 Agent 列表
- **AC-OC-AGENT-001**：系统可从 OpenClaw 拉取可用 agent 列表（agent_id、name、description、capabilities）。
- **AC-OC-AGENT-002**：拉取失败时保留上次缓存列表并提示“列表可能过期”。
- **AC-OC-AGENT-003**：支持手动刷新 agent 列表。

### B2. Board 级默认绑定
- **AC-OC-AGENT-004**：Board 支持设置 `default_agent_id`（来自 OpenClaw agent 列表）。
- **AC-OC-AGENT-005**：Board 默认 agent 更新后，仅影响新建卡片与新 Run。
- **AC-OC-AGENT-006**：Board 默认 agent 变更写入事件 `board.default_agent_changed`。

### B3. Card 级绑定与覆盖
- **AC-OC-AGENT-007**：Card 支持选择 `agent_id`；未设置时继承 Board 默认 agent。
- **AC-OC-AGENT-008**：Card 的 `agent_id` 可在执行前修改；执行中不可改当前 Run 的 agent。
- **AC-OC-AGENT-009**：Card agent 变更写入事件 `card.agent_changed`（含 old/new）。
- **AC-OC-AGENT-010**：触发 Run 时必须快照 `agent_id` 到 Run 记录，确保可追溯。

### B4. Agent 可用性校验
- **AC-OC-AGENT-011**：若所选 `agent_id` 在 OpenClaw 侧不可用，Run 创建失败并返回 409。
- **AC-OC-AGENT-012**：当 agent 被下线后，历史 Run 不受影响但新 Run 需阻止并提示。

---

## C. OpenClaw Run 联动（执行链路）

### C1. Run 请求构造
- **AC-OC-RUN-001**：提交 OpenClaw 的请求体必须包含：
  - `card_id`
  - `run_id`
  - `agent_id`
  - `goal`
  - `context`（可选）
  - `acceptance_criteria`（可选）
- **AC-OC-RUN-002**：请求中需带追踪标识（如 correlation_id）用于日志串联。

### C2. Run 状态同步
- **AC-OC-RUN-003**：Run 至少支持状态：`queued/running/succeeded/failed`。
- **AC-OC-RUN-004**：系统支持两种同步方式（二选一或并存）：
  - 轮询 OpenClaw run 状态
  - Webhook 回调更新状态
- **AC-OC-RUN-005**：状态更新必须幂等（重复回调不会造成状态回退）。

### C3. 结果落库
- **AC-OC-RUN-006**：Run 成功时保存 `output_summary` 和 `output_payload`。
- **AC-OC-RUN-007**：Run 失败时保存 `error_message`、错误码（若有）。
- **AC-OC-RUN-008**：Run 成功后卡片自动进入 `review`，并记录 `run.succeeded` 事件。

### C4. 超时与取消
- **AC-OC-RUN-009**：Run 超过设定超时时间应标记失败（timeout）。
- **AC-OC-RUN-010**：支持取消运行中的 Run（若 OpenClaw 支持 cancel 接口）。
- **AC-OC-RUN-011**：取消动作写入 `run.cancelled` 事件。

---

## D. 审批与重跑（与 OpenClaw 深度联动）

### D1. Approve
- **AC-OC-APR-001**：`approved` 后卡片进入 `done`，不得自动再触发 Run。
- **AC-OC-APR-002**：审批记录需绑定具体 `run_id + agent_id`。

### D2. Changes Requested / Reject
- **AC-OC-APR-003**：`changes_requested` 必须填写 comment，且长度 >= 5 字符。
- **AC-OC-APR-004**：系统将审批意见注入下一轮输入上下文（可见可追溯）。
- **AC-OC-APR-005**：重跑默认沿用上一轮 `agent_id`，除非用户显式改 agent。
- **AC-OC-APR-006**：重跑 Run 需保存 `rerun_of_run_id`，形成链路。

### D3. 跨 Agent 重跑（同为 OpenClaw agents）
- **AC-OC-APR-007**：用户可在重跑前切换为另一个 OpenClaw agent。
- **AC-OC-APR-008**：切换后新 Run 的 `agent_id` 正确记录，历史 Run 不变。
- **AC-OC-APR-009**：事件中可清晰展示“因驳回从 agent A 切到 agent B”。

---

## E. OpenClaw 设置（多 Agent）页面交互

### E1. 页面信息结构
- **AC-OC-SET-001**：设置页包含三个区块：
  1) Connection（endpoint/api key）
  2) Agent Catalog（可用 agent 列表）
  3) Defaults（默认 agent、默认超时）
- **AC-OC-SET-002**：Agent 列表支持搜索（name/id）。
- **AC-OC-SET-003**：用户可查看 agent 基础能力标签（如 coding/reasoning/tools）。

### E2. 默认策略
- **AC-OC-SET-004**：支持设置 workspace 级默认 agent（可被 board/card 覆盖）。
- **AC-OC-SET-005**：优先级规则固定：`Card > Board > Workspace Default`。
- **AC-OC-SET-006**：当上层默认值变化时，不自动覆盖已显式设置的下层值。

---

## F. 安全与权限（OpenClaw 相关）

- **AC-OC-SEC-001**：OpenClaw API Key 仅后端可读，前端永不回传明文。
- **AC-OC-SEC-002**：所有对 OpenClaw 的请求都带服务端鉴权头，不允许浏览器直连。
- **AC-OC-SEC-003**：审计日志不记录敏感字段（api_key/token）。

---

## G. 观测与可运维性

- **AC-OC-OBS-001**：每次 OpenClaw 调用记录请求ID、run_id、agent_id、耗时、结果状态。
- **AC-OC-OBS-002**：失败率、平均耗时可统计（最小可通过日志聚合实现）。
- **AC-OC-OBS-003**：单个 Run 支持追踪完整链路（提交->执行->回写->审批）。

---

## H. 兼容与降级

- **AC-OC-FB-001**：OpenClaw 暂时不可用时，系统可阻止新 Run 并给用户明确提示。
- **AC-OC-FB-002**：OpenClaw 不可用不影响历史数据浏览（runs/events 可读）。
- **AC-OC-FB-003**：Agent 列表拉取失败时仍可使用“上次可用默认 agent”（若存在）。

---

## I. E2E 场景（OpenClaw 多 Agent）

- **AC-OC-E2E-001**：配置连接成功 -> 拉取 agent 列表 -> 设置 Board 默认 agent -> 新卡片执行成功。
- **AC-OC-E2E-002**：卡片 override agent -> Run 成功 -> Approve -> Done。
- **AC-OC-E2E-003**：Run 成功 -> Reject(comment) -> 切换另一个 agent 重跑 -> Approve。
- **AC-OC-E2E-004**：agent 下线后新 Run 被阻止且提示明确；历史 Run 可正常查看。