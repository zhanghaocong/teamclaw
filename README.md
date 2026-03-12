# TeamClaw

Agent-native Kanban for human + OpenClaw collaboration with review/approval workflows.

## Vision

TeamClaw is a web control plane for human-agent collaboration:
- Manage work in a Kanban board
- Assign execution to OpenClaw
- Review outputs with approve / request changes
- Keep a full audit trail for accountability

## Why TeamClaw

Managing multiple agents inside plain IM tools is hard:
- Context gets fragmented across threads
- Agent outputs are hard to reuse and track
- Human checkpoints are inconsistent
- Progress visibility is poor

TeamClaw turns agent work into a structured, visible, and reviewable workflow.

## Core Concepts

- **Board**: Workspace for a stream of work (MVP acts like a project container)
- **Card**: Unit of work with clear goal and acceptance criteria
- **Run**: One OpenClaw execution attempt for a card
- **Approval**: Human decision on a run (`approved` / `changes_requested`)
- **Event**: Immutable activity log for audit and replay

## Product Principles

1. **Task-first, not chat-first**  
   Conversations should serve tasks, not replace them.
2. **Human-in-the-loop by default**  
   Final quality gates belong to humans.
3. **Traceability over magic**  
   Every action should be explainable and auditable.
4. **Simple workflows win**  
   Start with a reliable Kanban loop before advanced orchestration.

## Roadmap

### v0.01 (MVP)

- Create and manage work through a Kanban board
- Use a standard card lifecycle: `todo -> running -> review -> done`
- Trigger OpenClaw execution from a card
- Track per-card run history
- Review run results with:
  - `approved` (move forward)
  - `changes_requested` (feedback + rerun path)
- Keep an activity timeline for key user/agent actions

### v0.02

- Card templates for recurring workflows
- Basic artifact panel (docs/code/report outputs)
- Better filtering/search in board view
- Lightweight notifications for review-needed cards

### v0.03

- Multi-board overview
- Team collaboration improvements (@mention, ownership clarity)
- Cost and usage visibility per card/run
- Connector abstraction for additional agent providers

## Current Status

Early-stage MVP.  
Initial focus: OpenClaw-first workflow with fast feedback cycles.

## Architecture

```
teamclaw/
├── packages/
│   ├── web/        # Next.js frontend + API routes
│   ├── shared/     # Shared domain types and utilities
├── config/          # Default configuration files
└── docs/           # Documentation
```

## Tech Stack

Frontend: Next.js 16, TypeScript, Tailwind CSS
Backend: Next.js API routes
AI: Vercel AI SDK
Database: SQLite
Build: pnpm, Turborepo

## Getting Started

### Requirements

- Node.js 20+
- pnpm 10+

### Install

```bash
pnpm install
```

### Run Web App

```bash
pnpm dev --filter @teamclaw/web
```

Open `http://localhost:3000`.

### Health Check API

`GET /api/health`

Example:

```bash
curl http://localhost:3000/api/health
```

### Workspace Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
```
