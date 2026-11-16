import { ActivitySection } from './Activity';
import { LimitsSection } from './Limits';
import './usage.css';

/** Settings > Usage: plan limits per account, then where the tokens went. */
export function Usage() {
  return (
    <div className="set-stack usage-page">
      <LimitsSection />
      <ActivitySection />
    </div>
  );
}
