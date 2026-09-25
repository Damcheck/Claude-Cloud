/**
 * Models write Markdown; Telegram renders a small HTML subset. This converts the
 * common constructs and escapes everything else, so a reply can never break parsing
 * (and if it somehow does, api.ts resends as plain text).
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(text: string): string {
  // Protect inline code first so its contents aren't formatted.
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? "");
}

export function markdownToTelegramHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let inFence = false;
  let fenceLang = "";
  let fence: string[] = [];

  for (const line of lines) {
    const fenceMatch = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1] ?? "";
        fence = [];
      } else {
        const cls = fenceLang ? ` class="language-${fenceLang}"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(fence.join("\n"))}</code></pre>`);
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1] ?? "")}</b>`);
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2] ?? "")}`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`<blockquote>${inline(quote[1] ?? "")}</blockquote>`);
      continue;
    }
    out.push(inline(line));
  }
  if (inFence) {
    const cls = fenceLang ? ` class="language-${fenceLang}"` : "";
    out.push(`<pre><code${cls}>${escapeHtml(fence.join("\n"))}</code></pre>`);
  }
  return out.join("\n");
}

/**
 * Split Markdown into chunks of at most `max` characters, preferring paragraph then line
 * boundaries. A chunk that ends inside a code fence is closed and the next one reopened,
 * so every chunk renders on its own.
 */
export function splitMarkdown(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  let reopen = "";
  const budget = max - 8; // room for a closing/opening fence
  while (reopen.length + rest.length > max) {
    const window = rest.slice(0, budget - reopen.length);
    let cut = window.lastIndexOf("\n\n");
    if (cut < window.length * 0.5) cut = window.lastIndexOf("\n");
    if (cut < window.length * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = window.length;
    let chunk = reopen + rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    const fences = chunk.match(/^\s*```[\w+-]*\s*$/gm) ?? [];
    if (fences.length % 2 === 1) {
      const lang = /```([\w+-]*)/.exec(fences[fences.length - 1] ?? "")?.[1] ?? "";
      chunk += "\n```";
      reopen = "```" + lang + "\n";
    } else {
      reopen = "";
    }
    chunks.push(chunk);
  }
  if (rest) chunks.push(reopen + rest);
  return chunks;
}

/** Text suitable for text-to-speech: no code, no markup, no URLs read out character by character. */
export function speechText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (code in the chat) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[*_~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split speech into sentence groups so the first audio can play while the rest is generated. */
export function speechChunks(text: string, maxChars = 280): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && (current + s).length > maxChars) {
      chunks.push(current.trim());
      current = "";
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
