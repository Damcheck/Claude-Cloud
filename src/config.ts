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
  /** Max output tokens for a normal agent turn. */
  maxOutputTokens: 700,
  /** How many recent messages of the chat each agent sees. */
  transcriptWindow: 40,
  /** Max core agents answering a plain chat message. */
  chatAgents: 2,
  /** Characters of a skill result fed back to the model. */
  maxSkillResultChars: 6000,
  /** Telegram's hard limit per message. */
  telegramMaxChars: 4096,
} as const;
