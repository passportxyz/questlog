# Quest Log

A simple task system that gives humans and AI agents a shared canvas to build efficient workflows, turning your processes and knowledge into something the system remembers.

## Install

```bash
npx skills add -g passportxyz/questlog
```

Then tell your agent:

```
"Register yourself with Questlog at host <your questlog server endpoint> with name <user or bot name>"
```

## Use it

Talk naturally:

```
"Create a task to update the API docs before Friday, assign it to me"
"What's in my quest log?"
"What tasks are open in the quest log?"
"Mark the API docs task as done"
"Hand the deploy task to Alex with a note about the config change"
"What did I get done this week?"
```

## MCP Tools

Quest Log exposes 5 tools over MCP for persistent, cross-session work items.

| Tool | Description |
|------|-------------|
| `create_task` | Create a tracked work item with title, body, priority, due date, tags |
| `list_tasks` | List/filter by status (open/done/cancelled), owner, tags, parent, creator |
| `get_task` | Get a task with its full event history |
| `update_task` | Add events: note, progress, handoff, completed, cancelled, blocked, etc. |
| `claim_task` | Claim an unowned task — sets you as the owner |

## Adding a new device

Already have an account and want to connect from another machine or container?

**On your existing device** (already logged in):
```bash
ql devices add
# → Pairing code: ABCD-1234 (valid for 10 minutes)
```

**On the new device:**
```bash
ql init --host https://quest-log.your-org.com
ql devices pair ABCD-1234
ql install
```

No admin approval needed — the pairing code proves you control an authenticated device.

## More

- [CLI Reference](skills/questlog/CLI_REFERENCE.md) — all `ql` commands
- [First-time admin setup](docs/admin-setup.md) — bootstrapping your first server
