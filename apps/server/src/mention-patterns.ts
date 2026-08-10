const DEFAULT_MENTION_PATTERNS = [
  String.raw`(?<![\w@])@?hermes\s+agent\b[,:\-]?`,
  String.raw`(?<![\w@])@?hermes\b[,:\-]?`,
];

export function compileMentionPatterns(raw: string[] | undefined): RegExp[] {
  const patterns = raw?.length ? raw : DEFAULT_MENTION_PATTERNS;
  return patterns.map((source) => new RegExp(source, "i"));
}

export function matchesMention(text: string, patterns: RegExp[]): boolean {
  if (!text || !patterns.length) return false;
  return patterns.some((pattern) => pattern.test(text));
}

export function cleanMentionText(text: string, patterns: RegExp[]): string {
  if (!text) return text;
  for (const pattern of patterns) {
    const match = pattern.exec(text.trimStart());
    if (match && match.index === 0) {
      const cleaned = text
        .trimStart()
        .slice(match[0].length)
        .trimStart()
        .replace(/^[,:\-\s]+/, "");
      return cleaned || text;
    }
  }
  return text;
}
