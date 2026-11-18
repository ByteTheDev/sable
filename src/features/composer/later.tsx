import type { ReactNode } from 'react';

/**
 * A menu's contents, built only when the menu draws them (while it is open). The trigger re-renders
 * with its control (a send, a status change, a session mounting) and a closed menu should cost
 * nothing then: written inline, every row's elements would be built on each of those renders.
 */
export function Later({ children }: { children: () => ReactNode }) {
  return <>{children()}</>;
}
