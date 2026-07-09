const MODIFIER_CODES = [
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
];

export function keyboardShortcut(event: KeyboardEvent) {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  const key = event.code || event.key;
  if (!MODIFIER_CODES.includes(key)) {
    parts.push(key);
  }

  return parts.length ? parts.join('+') : '';
}

export function formatShortcut(shortcut: string) {
  return shortcut
    .replaceAll('Control', 'Ctrl')
    .replaceAll('Key', '')
    .replaceAll('Digit', '')
    .replaceAll('Arrow', '');
}

export function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
}
