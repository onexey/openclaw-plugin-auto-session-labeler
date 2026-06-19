// openclaw-plugin-auto-session-labeler
// Automatically applies a short descriptive label to a session as soon as the
// first user message arrives — generated in the background so it never delays
// the actual answer.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "session-labeler",
  name: "Session Labeler",
  description: "Auto-labels sessions based on the initial user prompt",

  register(api) {
    const DEFAULT_MAX_LENGTH = 40;
    const DEFAULT_SKIP_KINDS = ["cron", "hook"];

    // In-memory guard so we don't fire twice for the same session within one
    // process lifetime. Resets on restart; the stored-label check below covers
    // sessions already labelled before a restart.
    const inFlight = new Set();

    // ── Single hook: label on the first prompt, in the background ───────────
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        try {
          const cfg = ctx.pluginConfig ?? {};
          const maxLen = typeof cfg.maxLabelLength === "number" ? cfg.maxLabelLength : DEFAULT_MAX_LENGTH;
          const skipKinds = Array.isArray(cfg.skipKinds) ? cfg.skipKinds : DEFAULT_SKIP_KINDS;

          const { agentId, sessionKey } = ctx;
          if (!agentId || !sessionKey) return;

          // Skip cron-driven runs when configured to.
          if (ctx.jobId && skipKinds.includes("cron")) return;

          // Already generating a label for this session.
          if (inFlight.has(sessionKey)) return;

          const prompt = event.prompt;
          if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) return;

          // Session already has a label (manual or prior run) — leave it alone.
          const existingEntry = api.runtime.agent.session.getSessionEntry({ agentId, sessionKey });
          if (existingEntry?.label) return;

          // Mark in-flight BEFORE the async work so a rapid second turn can't
          // double-fire while the first label is still generating.
          inFlight.add(sessionKey);

          const capturedPrompt = prompt.trim().slice(0, 800);

          // Fire-and-forget: do NOT await here, or we delay the user's answer.
          // The label generation + write run in the background while the main
          // turn proceeds.
          void generateAndWriteLabel({
            api,
            agentId,
            sessionKey,
            prompt: capturedPrompt,
            maxLen,
            inFlight,
          });
        } catch (err) {
          console.error("[session-labeler] before_prompt_build error:", err?.message ?? err);
        }
      },
      { priority: 10 },
    );
  },
});

async function generateAndWriteLabel({ api, agentId, sessionKey, prompt, maxLen, inFlight }) {
  try {
    // Re-check the stored label — a concurrent path may have set it.
    const existingEntry = api.runtime.agent.session.getSessionEntry({ agentId, sessionKey });
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
            `User's opening message: ${prompt}`,
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
      agentId,
      sessionKey,
      preserveActivity: true,
      update: (entry) => ({ ...entry, label }),
    });
  } catch (err) {
    console.error("[session-labeler] label write failed:", err?.message ?? err);
    // Drop the in-flight marker on failure so a later turn can retry.
    inFlight.delete(sessionKey);
  }
}
