# openclaw-plugin-auto-session-labeler

An [OpenClaw](https://openclaw.ai) plugin that automatically generates and applies a short, descriptive label to each session — so your session list stays scannable without manual naming.

The label is generated **the moment your first message arrives**, in the background, so it shows up while the answer is still being produced and never delays your response.

## What it does

On your first message in a new session, the plugin:

1. Captures the opening prompt in the `before_prompt_build` hook (fires before the model call)
2. Fires an LLM call **in the background** (not awaited) to produce a 2–6 word label
3. Writes it to the session entry via `patchSessionEntry` — without touching activity timestamps

Because the label generation is fire-and-forget, the main turn proceeds immediately — the label simply appears a second or two later, in parallel with the answer.

Sessions that already have a label (set manually or by a prior run) are left alone. Cron and hook sessions are skipped by default.

**Cost:** ~30 tokens per new session, one-time only.

## Install

```bash
openclaw plugins install git:onexey/openclaw-plugin-auto-session-labeler
```

Then apply the required config:

```bash
echo '{
  "plugins": {
    "allow": ["session-labeler"],
    "entries": {
      "session-labeler": {
        "enabled": true
      }
    }
  }
}' | openclaw config patch --stdin
```

Restart the gateway:

```bash
openclaw gateway restart
```

## Configuration

### Required

| Field | Why it's needed |
|---|---|
| `plugins.allow` must include `"session-labeler"` | OpenClaw requires non-bundled plugins to be explicitly trusted before their hooks are honoured. Without this, `before_prompt_build` fires but the plugin is silently ignored. |

> **Note:** This plugin only uses the `before_prompt_build` hook, which is **not** a raw-conversation hook, so it does **not** require `hooks.allowConversationAccess`. (Earlier versions used `agent_end` and needed that flag — it's no longer necessary.)

### Optional

```json
{
  "plugins": {
    "allow": ["session-labeler"],
    "entries": {
      "session-labeler": {
        "enabled": true,
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

A single hook does everything:

- **`before_prompt_build`** — fires before the model call on every turn. On the first turn of an unlabelled session, it captures the user's prompt and kicks off label generation **without awaiting it**, so the actual answer is never blocked.
- The background task calls `api.runtime.llm.complete` with a tight label-generation prompt, sanitizes the result (`result.text`), and writes it via `patchSessionEntry({ preserveActivity: true })`.

An in-memory `inFlight` set prevents double-firing within a process lifetime; the stored-label check (`getSessionEntry`) prevents re-labelling sessions that already have a label, including across restarts.

## Notes

- Failures are logged (`[session-labeler] label write failed: ...`) but never surface to the user or interrupt a session
- In-memory tracking resets on gateway restart — the plugin re-checks the stored session label on the next first turn, so sessions already labelled before the restart stay labelled
- `plugins.allow` must include `session-labeler` — without it the plugin loads but its hook is silently skipped

## License

MIT
