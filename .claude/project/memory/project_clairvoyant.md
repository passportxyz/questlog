---
name: clairvoyant-overview
description: Clairvoyant is an event-sourced task management system with human/agent handoffs, built for passportxyz
type: project
---

Clairvoyant — AI-native task system where the core primitive is the handoff between humans and agents.

**Why:** Named after the Skyrim spell that shows a glowing trail to your objective. Designed to let agents and humans coordinate on tasks with full event history.

**How to apply:**
- Event-sourced Postgres backend (append-only events, tasks are materialized views)
- Auth via SSH keypairs
- MCP server as primary interface (hosted, not local)
- Thin CLI wrapper (`cv`) for non-MCP contexts
- Built with Claude Code SDK
- Deployment: Wayfarer server in a Borg container, linked to Borg's broker for GitHub creds
- Design thread: Tasks thread (6968) — Lucian drives product decisions there

Key entities: tasks, events, users (humans and agents are both users)
Design principle: The task system is dumb — no routing opinions. Agents self-select tasks.
