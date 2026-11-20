import { useStore } from '@/state/store';
import { pruneReviews } from './model';
import { packReviews, unpackReviews } from './persist';

/**
 * A chat's pending review survives a restart: the comments are kept in localStorage, like the
 * composer's drafts, and read back into the store once. Sessions that are gone are dropped once
 * the bridge has said which sessions exist.
 */
const KEY = 'sable.review.v1';

let started = false;

/** Reads the kept reviews into the store once, then writes changes back (debounced, and on leaving). */
export function keepReviews() {
  if (started || typeof localStorage === 'undefined') return;
  started = true;
  let saved = '';
  try {
    saved = localStorage.getItem(KEY) ?? '';
    const kept = unpackReviews(saved);
    // What is already in the store (written before this ran) wins over what was kept.
    if (Object.keys(kept).length) useStore.setState((s) => ({ reviews: { ...kept, ...s.reviews } }));
  } catch {
    return;
  }
  let timer = 0;
  const write = () => {
    timer = 0;
    const next = packReviews(useStore.getState().reviews);
    if (next === saved) return;
    saved = next;
    try {
      if (next === '{}') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* full or private: the comments stay in memory */
    }
  };
  let pruned = false;
  const prune = () => {
    const s = useStore.getState();
    if (pruned || !s.ready) return;
    pruned = true;
    const next = pruneReviews(s.reviews, (id) => !!s.sessions[id]);
    if (next !== s.reviews) useStore.setState({ reviews: next });
  };
  prune();
  useStore.subscribe((s, p) => {
    if (s.ready && !p.ready) prune();
    if (s.reviews === p.reviews || timer) return;
    timer = window.setTimeout(write, 400);
  });
  window.addEventListener('pagehide', write);
  window.addEventListener('beforeunload', write);
}
