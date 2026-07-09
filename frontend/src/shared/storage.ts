export function readStoredValue(key: string, fallback: string) {
  return localStorage.getItem(key) || fallback;
}

export function readStoredNumber(key: string, fallback: number, min: number, max: number) {
  const storedValue = localStorage.getItem(key);
  if (storedValue === null || storedValue.trim() === '') {
    return fallback;
  }

  const value = Number(storedValue);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return clampNumber(value, min, max);
}

export function readStoredBoolean(key: string, fallback: boolean) {
  const value = localStorage.getItem(key);
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return fallback;
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
