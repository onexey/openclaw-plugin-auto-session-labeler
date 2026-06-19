// openclaw-plugin-auto-session-labeler
// Automatically applies a short descriptive label to a session after the first user message.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "session-labeler",
  name: "Session Labeler",
  description: "Auto-labels sessions based on the initial user prompt",

  register(api) {
    const DEFAULT_MAX_LENGTH = 40;
    const DEFAULT_SKIP_KINDS = ["cron", "hook"];

    // In-memory guards. Reset on restart; the storage-level label check below
    // prevents re-labelling already-labelled sessions across restarts.
    const labelledSessions = new Set();
    const pendingPrompts = new Map();

    // ── Hook 1: capture the first user prompt ───────────────────────────────
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        try {
          const { agentId, sessionKey } = ctx;
          if (!agentId || !sessionKey) return;
          if (labelledSessions.has(sessionKey)) return;
          if (pendingPrompts.has(sessionKey)) return;

          const prompt = event.prompt;
          if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) return;

          const existingEntry = api.runtime.agent.session.getSessionEntry({ agentId, sessionKey });
          if (existingEntry?.label) {
            labelledSessions.add(sessionKey);
            return;
          }

          pendingPrompts.set(sessionKey, { prompt: prompt.trim().slice(0, 800), agentId });
        } catch (err) {
          console.error("[session-labeler] before_prompt_build error:", err?.message ?? err);
        }
      },
      { priority: 10 },
    );

    // ── Hook 2: generate + write label after the first turn completes ───────
    api.on(
      "agent_end",
      async (_event, ctx) => {
        try {
          const cfg = ctx.pluginConfig ?? {};
          const maxLen = typeof cfg.maxLabelLength === "number" ? cfg.maxLabelLength : DEFAULT_MAX_LENGTH;
          const skipKinds = Array.isArray(cfg.skipKinds) ? cfg.skipKinds : DEFAULT_SKIP_KINDS;

          const { agentId, sessionKey } = ctx;
          if (!agentId || !sessionKey) return;

          // Skip cron-triggered runs when configured to.
          if (ctx.jobId && skipKinds.includes("cron")) {
            pendingPrompts.delete(sessionKey);
            return;
          }

          const captured = pendingPrompts.get(sessionKey);
          if (!captured) return;

          // Consume immediately so a second turn can't double-fire.
          pendingPrompts.delete(sessionKey);
          labelledSessions.add(sessionKey);

          const existingEntry = api.runtime.agent.session.getSessionEntry({
            agentId: captured.agentId,
            sessionKey,
          });
          if (existingEntry?.label) return;

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

          // api.runtime.llm.complete returns the generated text on `.text`.
          const rawLabel = (result?.text ?? "").trim();
          if (!rawLabel) return;

          const label = rawLabel
            .replace(/^["'`«»]+|["'`«»]+$/g, "")
            .split(/\r?\n/)[0]
            .trim()
            .slice(0, maxLen);

          if (!label) return;

          await api.runtime.agent.session.patchSessionEntry({
            agentId: captured.agentId,
            sessionKey,
            preserveActivity: true,
            update: (entry) => ({ ...entry, label }),
          });
        } catch (err) {
          console.error("[session-labeler] label write failed:", err?.message ?? err);
        }
      },
      { priority: 10 },
    );
  },
});
