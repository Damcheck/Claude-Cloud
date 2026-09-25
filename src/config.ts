/** Hard budgets. Every loop in the council is bounded by one of these. */
export const LIMITS = {
  /** Max agent posts in a single discussion (one human trigger). */
  maxPostsPerDiscussion: 15,
  /** Max rounds in /debate. */
  debateRounds: 3,
  /** Pause between two agent posts, so the chat reads like a conversation. */
  cooldownMs: 1500,
  /** Max skill (tool) calls an agent may make during one turn. */
  maxToolCallsPerTurn: 4,
  /** Coding specialists get more, because code → run → fix needs several steps. */
  maxToolCallsPerTurnSpecialist: 8,
  /** Max output tokens for a normal agent turn. */
  maxOutputTokens: 700,
  /** Max output tokens when speaking (voice notes and live calls). */
  maxVoiceOutputTokens: 260,
  /** How many recent messages of the chat each agent sees. */
  transcriptWindow: 40,
  /** Max core agents answering a plain chat message. */
  chatAgents: 2,
  /** Characters of a skill result fed back to the model. */
  maxSkillResultChars: 6000,
  /** Telegram's hard limit per message. */
  telegramMaxChars: 4096,
  /** Telegram's caption limit (voice notes, photos). */
  telegramMaxCaption: 1024,
  /** Older-memory snippets injected by semantic search. */
  retrievedMemories: 5,
  /** A discussion with at least this many posts is summarized into long-term memory. */
  summarizeAfterPosts: 3,
  /** Agents that may speak after one utterance in a live call. */
  liveMaxSpeakers: 2,
  /** Minimum bid importance to get the floor in a live call. */
  liveMinImportance: 0.35,
  /** Sandbox command timeout. */
  sandboxTimeoutMs: 120_000,
  /** How long Telegram update ids are remembered for de-duplication. */
  seenUpdatesTtlMs: 3 * 24 * 3600 * 1000,
} as const;

/** Models used for plumbing rather than as council members. */
export const SYSTEM_MODELS = {
  speechToText: "@cf/openai/whisper-large-v3-turbo",
  textToSpeech: "@cf/deepgram/aura-2-en",
  embeddings: "@cf/baai/bge-m3",
  /** Summaries and speak bids: fast and cheap. */
  fast: "@cf/zai-org/glm-5.3-flash",
} as const;
