export function normalizedChatText(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function chatTime(sentAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(sentAt));
}
