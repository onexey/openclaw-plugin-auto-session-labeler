# openclaw-plugin-auto-session-labeler

An [OpenClaw](https://openclaw.ai) plugin that automatically generates and applies a short, descriptive label to each session after the first message — so your session list stays scannable without manual naming.

## What it does

After your first message in a new session, the plugin:

1. Captures the opening prompt (via the `before_prompt_build` hook)
2. Once the turn completes (`agent_end`), asks the LLM to produce a 2–6 word label
3. Writes it to the session entry via `patchSessionEntry` — without touching activity timestamps

Sessions that already have a label (set manually or by a prior run) are left alone. Cron and hook sessions are skipped by default.

**Cost:** ~30 tokens per new session, one-time only.

## Install

```bash
openclaw plugins install git:onexey/openclaw-plugin-auto-session-labeler
```

Then enable `allowConversationAccess` for the `agent_end` hook (required by OpenClaw for conversation-level hooks):

```bash
echo '{"plugins":{"entries":{"session-labeler":{"hooks":{"allowConversationAccess":true}}}}}' \
  | openclaw config patch --stdin
```

Restart the gateway:

```bash
openclaw gateway restart
```

## Configuration

All config is optional. Defaults work out of the box.

```json
{
  "plugins": {
    "entries": {
      "session-labeler": {
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "maxLabelLength": 40,
          "skipKinds": ["cron", "hook"]
        }
      }
    }
  }
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `maxLabelLength` | `number` | `40` | Max characters in the generated label |
| `skipKinds` | `string[]` | `["cron", "hook"]` | Session kinds to skip — cron jobs and hook sessions won't be labelled |

## How it works

Two hooks cooperate:

- **`before_prompt_build`** — fires before the model call on every turn. On the first turn of an unlabelled session, it stashes the user's prompt in an in-memory map.
- **`agent_end`** — fires after the turn completes. If a stashed prompt exists, it calls `api.runtime.llm.complete` with a tight label-generation prompt, sanitizes the result, and writes it via `patchSessionEntry({ preserveActivity: true })`.

This two-hook design avoids relying on undocumented fields of the `agent_end` event and keeps label generation safely post-turn.

## Notes

- Failures are logged (`[session-labeler] label write failed: ...`) but never surface to the user or interrupt a session
- In-memory tracking resets on gateway restart — the plugin re-checks the stored session label on the next first turn, so sessions already labelled before the restart stay labelled
- `allowConversationAccess: true` is required by OpenClaw for any plugin using `agent_end`

## License

MIT
