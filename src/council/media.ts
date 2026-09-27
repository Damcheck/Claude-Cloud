/**
 * Pick a sticker emotion only when the conversation contains a strong social cue.
 * Returning null is deliberate: human-feeling media is occasional and relevant,
 * not a sticker appended mechanically to every technical answer.
 */
export function contextualStickerEmoji(founderText: string, replyText: string): string | null {
  const founder = founderText.toLowerCase();
  const reply = replyText.toLowerCase();
  const combined = `${founder}\n${reply}`;

  const cues: Array<[RegExp, string]> = [
    [/\b(hello|hi|hey|yo|good morning|good afternoon|good evening)\b/, "👋"],
    [/\b(lol|lmao|rofl|haha+|funny|hilarious|crack(?:ed|ing) me up)\b/, "😂"],
    [/\b(?:congrat\w*|celebrat\w*|(?:we |finally )?won|nailed it|well done|victory)\b/, "🥳"],
    [/\b(thank|appreciat|love (?:it|this|that)|much love)\w*\b/, "❤️"],
    [/\b(wtf|wow|shocking|unbelievable|mind.?blow|no freaking way|that's crazy|that is crazy)\b/, "🤯"],
    [/\b(fire|amazing|brilliant|incredible|insane idea|excellent)\b/, "🔥"],
    [/\b(?:made|making|earned|earning|locked|banked|took)\s+(?:a\s+)?(?:serious\s+|real\s+|good\s+|huge\s+)?(?:profit|money|cash|bank)|\b(?:profitable|payday|got rich)\b/, "🤑"],
    [/\b(furious|angry|pissed|mad at|rage)\b/, "😡"],
    [/\b(sad|heartbreak|we lost|big loss|failed badly|disappointed|devastated|grieving)\b/, "😢"],
    [/\b(nonsense|ridiculous|absurd|no way|hard disagree|that's wrong|that is wrong)\b/, "🙄"],
    [/\b(confused|don't understand|do not understand|what do you mean|how come)\b/, "🤔"],
    [/\b(exactly|agreed|you're right|you are right|good point|makes sense)\b/, "👍"],
  ];

  // Prefer the founder's tone. The reply is used only when it contains an equally
  // explicit social reaction, so ordinary analysis does not generate generic media.
  for (const [pattern, emoji] of cues) if (pattern.test(founder)) return emoji;
  for (const [pattern, emoji] of cues.slice(1)) if (pattern.test(combined)) return emoji;
  return null;
}
