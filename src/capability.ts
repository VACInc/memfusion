const SILENT_REPLY_TOKEN = "NO_REPLY";

export const TOOL_NAMES = ["memory_search", "memory_get", "memory_store"] as const;

/** System prompt lines describing the fused memory tools that are actually available. */
export function buildPromptSection(params: { availableTools: Set<string> }): string[] {
  const has = (name: string) => params.availableTools.has(name);
  if (!has("memory_search") && !has("memory_store")) return [];
  const lines = ["## Memory", "Memory Fusion joins several memory stores into one memory."];
  if (has("memory_search")) {
    lines.push(
      "Before answering questions about past work, decisions, people, preferences or anything the user told you earlier, call memory_search; read a full item with memory_get using its ref.",
    );
  }
  if (has("memory_store")) {
    lines.push(
      "When you learn a durable fact, decision or preference worth recalling later, save it with memory_store as one self-contained entry. Do not store secrets.",
    );
  }
  return lines;
}

/** Pre-compaction flush that persists through memory_store, so it follows the store routing. */
export function resolveFlushPlan() {
  return {
    prompt: [
      "Pre-compaction memory flush.",
      "Save durable memories from this session with memory_store: one self-contained entry per fact, decision or preference.",
      "Use memory_search first to avoid storing something already remembered.",
      `If nothing is worth storing, reply with ${SILENT_REPLY_TOKEN}.`,
    ].join(" "),
    systemPrompt: [
      "Pre-compaction memory flush turn.",
      "The session is near auto-compaction; capture durable memories with memory_store.",
      `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
    ].join(" "),
    persistenceToolNames: ["memory_store"],
    lookupToolNames: ["memory_search", "memory_get"],
  };
}
