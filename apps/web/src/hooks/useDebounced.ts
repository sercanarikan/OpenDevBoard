import { useEffect, useState } from 'react';

/** Returns `value` after it stayed unchanged for `delayMs`. The first value is returned immediately. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs, debounced]);

  return debounced;
}
