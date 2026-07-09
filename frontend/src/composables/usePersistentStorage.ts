import { ref, watch, type Ref } from 'vue';
import { clampNumber, readStoredBoolean, readStoredNumber, readStoredValue } from '../shared/storage';

interface PersistentStringOptions {
  trim?: boolean;
  removeWhenEmpty?: boolean;
}

export function usePersistentString(
  key: string,
  fallback: string,
  options: PersistentStringOptions = {},
): Ref<string> {
  const value = ref(readStoredValue(key, fallback));

  watch(value, (nextValue) => {
    const normalizedValue = options.trim ? nextValue.trim() : nextValue;
    if (options.removeWhenEmpty && !normalizedValue) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, normalizedValue);
  });

  return value;
}

export function usePersistentNumber(key: string, fallback: number, min: number, max: number): Ref<number> {
  const value = ref(readStoredNumber(key, fallback, min, max));

  watch(value, (nextValue) => {
    localStorage.setItem(key, String(clampNumber(nextValue, min, max)));
  });

  return value;
}

export function usePersistentBoolean(key: string, fallback: boolean): Ref<boolean> {
  const value = ref(readStoredBoolean(key, fallback));

  watch(value, (nextValue) => {
    localStorage.setItem(key, String(nextValue));
  });

  return value;
}
