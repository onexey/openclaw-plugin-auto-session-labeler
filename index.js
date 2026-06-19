// openclaw-plugin-auto-session-labeler
// Automatically applies a short descriptive label to a session after the first user message.
//
// Strategy:
//   - Use `before_prompt_build` to capture the user's prompt on the first turn.
//     This hook fires before the model is called and receives `event.prompt`.
//   - Store the captured prompt in an in-memory map keyed by sessionKey.
//   - Use `agent_end` to generate the label via LLM and patch the session entry.
//   - "First turn" = session has no existing label AND we haven't labelled it yet (tracked in-memory).
//   - Skip cron/hook sessions (configurable).
//   - Silent failure: labelling is best-effort and never blocks a turn.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "session-labeler",
  name: "Session Labeler",
  description: "Auto-labels sessions based on the initial user prompt",

  register(api) {
    const DEFAULT_MAX_LENGTH = 40;
    const DEFAULT_SKIP_KINDS = ["cron", "hook"];

    // In-memory tracking of sessions we've labelled or are in the process of labelling.
    // This resets on gateway restart, but that's fine — we check the stored label first.
    const labelledSessions = new Set();

    // Capture first-turn prompts here: sessionKey -> { prompt, agentId }
    const pendingPrompts = new Map();

    // ── Hook 1: capture the first user prompt ───────────────────────────────
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        try {
          const { agentId, sessionKey } = ctx;
          if (!agentId || !sessionKey) return;

          // Already labelled this session (in-memory fast path)
          if (labelledSessions.has(sessionKey)) return;
          // Already have a pending prompt captured
          if (pendingPrompts.has(sessionKey)) return;

          const prompt = event.prompt;
          if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) return;

          // Check the stored session entry for an existing label
          const existingEntry = api.runtime.agent.session.getSessionEntry({ agentId, sessionKey });
          if (existingEntry?.label) {
            labelledSessions.add(sessionKey); // already has a label, skip forever
            return;
          }

          // Capture the prompt for agent_end to consume
          pendingPrompts.set(sessionKey, { prompt: prompt.trim().slice(0, 800), agentId });
        } catch (_err) {
          // silent
        }
      },
      { priority: 10 },
    );

    // ── Hook 2: generate + write label after turn completes ─────────────────
    api.on(
      "agent_end",
      async (_event, ctx) => {
        try {
          const cfg = ctx.pluginConfig ?? {};
          const maxLen = typeof cfg.maxLabelLength === "number" ? cfg.maxLabelLength : DEFAULT_MAX_LENGTH;
          const skipKinds = Array.isArray(cfg.skipKinds) ? cfg.skipKinds : DEFAULT_SKIP_KINDS;

          const { agentId, sessionKey } = ctx;
          if (!agentId || !sessionKey) return;

          // Skip cron-driven runs
          if (ctx.jobId && skipKinds.includes("cron")) return;

          // Check if we have a captured prompt for this session
          const captured = pendingPrompts.get(sessionKey);
          if (!captured) return;

          // Remove from pending immediately so we don't double-process on parallel turns
          pendingPrompts.delete(sessionKey);
          labelledSessions.add(sessionKey);

          // Double-check: maybe the session was already labelled between hooks
          const existingEntry = api.runtime.agent.session.getSessionEntry({
            agentId: captured.agentId,
            sessionKey,
          });
          if (existingEntry?.label) return;

          // Generate label via LLM
          const result = await api.runtime.llm.complete({
            messages: [
              {
                role: "user",
                content: [
                  "Generate a very short session label (2–6 words, no punctuation, no quotes) that describes what this conversation is about.",
                  "The label will be used as a session/tab title — make it descriptive and easy to scan at a glance.",
                  "Reply with ONLY the label text, nothing else. No explanation, no quotes, no punctuation.",
                  "",
                  `User's opening message: ${captured.prompt}`,
                ].join("\n"),
              },
            ],
            purpose: "session-labeler.label-gen",
            maxTokens: 30,
            temperature: 0.3,
          });

          const rawLabel = (result?.content ?? "").trim();
          if (!rawLabel) return;

          // Sanitize: strip quotes, keep first line, truncate
          const label = rawLabel
            .replace(/^["'`«»]+|["'`«»]+$/g, "")
            .split(/\r?\n/)[0]
            .trim()
            .slice(0, maxLen);

          if (!label) return;

          // Write to session entry without touching activity timestamps
          await api.runtime.agent.session.patchSessionEntry({
            agentId: captured.agentId,
            sessionKey,
            preserveActivity: true,
            update: (entry) => ({ ...entry, label }),
          });
        } catch (err) {
          // Silent failure — labelling must never break a session
          console.error("[session-labeler] label write failed:", err?.message ?? err);
        }
      },
      { priority: 10 },
    );
  },
});
