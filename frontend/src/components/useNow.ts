import { useSyncExternalStore } from 'react';

/*
 * One shared 1 s ticker for relative times ("3 秒前"). Only components that call useNow(true)
 * re-render; nothing is dispatched into the reducer. The interval runs only while someone listens.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const noop = () => () => undefined;
const snapshot = () => now;

/** Epoch ms at render time; the component re-renders every second while `active`. */
export function useNow(active = true): number {
  useSyncExternalStore(active ? subscribe : noop, snapshot, snapshot);
  return Date.now();
}
