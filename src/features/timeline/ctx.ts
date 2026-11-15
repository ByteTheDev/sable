import { createContext, useContext, useState } from 'react';
import type { TimelineItem } from '@shared/protocol';
import { useStore } from '@/state/store';

export interface TimelineCtxValue {
  sessionId: string;
  cwd: string;
  home: string;
  /** False while an existing transcript is being laid out; true once new items should animate in. */
  live: { current: boolean };
  /** True while the view follows the newest content; false once the reader has scrolled away. */
  stuck: { current: boolean };
}

export const TimelineCtx = createContext<TimelineCtxValue>({ sessionId: '', cwd: '', home: '', live: { current: false }, stuck: { current: true } });

export const useTimeline = () => useContext(TimelineCtx);

/** Subscribes to exactly one item, so a streaming delta re-renders one component. */
export function useItem<T extends TimelineItem = TimelineItem>(id: string): T | undefined {
  const { sessionId } = useTimeline();
  return useStore((s) => s.data[sessionId]?.items[id]) as T | undefined;
}

/**
 * Whether a component is mounting for something that just happened (as opposed to
 * history being laid out). Decided once at mount, so the entrance animation plays once.
 */
export function useFresh(ts?: number): boolean {
  const { live } = useTimeline();
  const [fresh] = useState(() => live.current && (ts === undefined || Date.now() - ts < 4000));
  return fresh;
}

export const EMPTY: string[] = [];
