/**
 * The limits and usage feature. Other areas mount these:
 *
 *   <LimitsGlance provider accountId />  one account's windows, compact, for a popover
 *   <LimitDot provider accountId />      a tiny amber (80%+) or red (used up) mark, or nothing
 *   useLimitLevel(provider, accountId)   the same as a value: 'near' | 'cap' | undefined
 *   openUsage()                          opens Settings > Usage
 */
import './usage.css';

export { LimitsGlance, LimitDot } from './Glance';
export { WindowRow } from './Limits';
export { Usage } from './Usage';
export { useLimitLevel, limitLevel, useLimitsReport, type LimitLevel } from '@/state/hooks';
export { openUsage } from '@/state/actions';
