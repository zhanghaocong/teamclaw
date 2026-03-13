# TeamClaw v0.0.1 需求文档（MVP）

## 1. 版本目标

v0.0.1 的目标是验证最小闭环是否成立：

1. 用户创建任务卡片  
2. 将任务交给 OpenClaw 执行  
3. 用户在 Review 阶段进行审批（通过/驳回）  
4. 任务完成或驳回后重跑  
5. 全流程可追踪（活动日志）

> 成功标准：用户可在 10 分钟内完整跑通一张卡片从 Todo 到 Done（含至少一次审批动作）。

---

## 2. 目标用户与场景

### 2.1 目标用户
- 个人开发者 / 小团队负责人
- 有多 Agent 协作需求的人
- 需要可审计执行过程的人机协作团队

### 2.2 核心场景
- 场景 A：产品/研发任务执行（例如：输出实现方案、代码草稿）
- 场景 B：内容任务执行（例如：输出文案、周报初稿）
- 场景 C：需要人工质量闸门的任务（必须人工 approve 才能完成）

---

## 3. 功能范围（In Scope）

## 3.1 看板与卡片管理
### 需求点
- 支持创建 Board
- Board 默认包含四列：`todo / running / review / done`
- 支持创建 Card，字段包含：
  - 标题（title，必填）
  - 目标（goal，必填）
  - 上下文（context，可选）
  - 验收标准（acceptance_criteria，可选）
- 支持卡片在列间流转（受状态机约束）

### 验收标准
- 用户可在 Board 中看到卡片并完成基础流转
- 非法状态流转被拦截（如 todo 直接 done）

---

## 3.2 OpenClaw 执行（Run）
### 需求点
- 卡片支持“执行”动作，触发一次 Run
- 每次 Run 记录以下信息：
  - run_id
  - 输入（input_payload）
  - 输出摘要（output_summary）
  - 原始输出（output_payload）
  - 状态（queued/running/succeeded/failed）
  - 开始/结束时间
- Run 成功后，卡片状态自动进入 `review`

### 验收标准
- 触发执行后可看到 Run 状态变化
- Run 失败时可见错误信息
- 同一卡片可多次执行并保留历史记录

---

## 3.3 审批流程（Approval）
### 需求点
- 在 `review` 状态下，用户可提交审批动作：
  - `approved`：卡片进入 `done`
  - `changes_requested`：必须填写反馈意见，卡片进入重跑路径
- 驳回后支持“基于反馈重跑”：
  - 将审批意见合并到新一轮输入上下文中
  - 触发新 Run

### 验收标准
- `approved` 后卡片状态正确进入 done
- `changes_requested` 无 comment 时不可提交
- 驳回后可触发新的 Run，且历史可追踪

---

## 3.4 活动日志（Event Timeline）
### 需求点
- 记录关键事件：
  - 卡片创建
  - 状态流转
  - Run 开始/成功/失败
  - 审批通过/驳回
- 每条事件包含：
  - actor（human/agent/system）
  - event_type
  - 时间
  - payload（可选）

### 验收标准
- 用户可在卡片详情中查看按时间排序的活动日志
- 审批与执行事件可被完整回放

---

## 4. 状态机规则

## 4.1 卡片状态
`todo -> running -> review -> done`

允许：
- `review -> running`（驳回后重跑）

禁止：
- `todo -> done`
- `running -> done`（必须经过 review）

## 4.2 Run 状态
`queued -> running -> succeeded | failed`

---

## 5. 非功能需求（MVP）

- 可用性：核心流程成功率 > 90%（在测试环境）
- 可观测性：每次执行和审批都有日志
- 一致性：状态流转通过后端统一校验
- 安全性（MVP）：OpenClaw API Key 不落前端

---

## 6. 数据结构（业务层）

核心实体：
- Board
- Column
- Card
- Run
- Approval
- Event

关系：
- Board 1:N Card
- Card 1:N Run
- Card 1:N Approval
- Card 1:N Event

---

## 7. API 范围（MVP）

- `POST /cards/:id/runs`：触发执行
- `GET /cards/:id/runs`：执行历史
- `POST /cards/:id/approvals`：提交审批
- `GET /cards/:id/events`：活动日志

---

## 8. 里程碑（建议 7 天）

- D1-D2：看板 + 卡片创建 + 状态机
- D3-D4：OpenClaw 执行链路（Run）
- D5：审批流程（approve/reject）
- D6：驳回重跑 + 活动日志
- D7：联调、验收���演示脚本

---

## 9. 不包含内容（Out of Scope）

- 多 Agent 接入（除 OpenClaw 外）
- 复杂权限系统（RBAC）
- 项目层级（Project）显式建模
- 自动任务拆解/DAG 编排
- 完整通知中心（邮件/IM 深度集成）

---

## 10. 验收用例（最小）

1. 新建卡片 -> 触发 Run -> Review -> Approve -> Done  
2. 新建卡片 -> 触发 Run -> Review -> Reject（写意见）-> 重跑 -> Approve  
3. 全流程中可查看完整事件时间线  
4. 非法流转被系统拒绝
