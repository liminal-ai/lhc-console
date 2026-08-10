export function renderRelayPrompt(prompt: string, channelContext?: string): string {
  if (!channelContext) return prompt;
  return `${channelContext}\n\n[New message]\n${prompt}`;
}
