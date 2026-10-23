import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function current(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(current);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(QUERY);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export function prefersReducedMotion(): boolean {
  return current();
}
