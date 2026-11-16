import type { ProviderId } from '@shared/protocol';
import { DitherField } from '@/art/DitherField';
import { LogoMark, ProviderMark, PROVIDER_NAME, Wordmark } from '@/art/Logo';
import { connectableAgents, planLabel, signedInAccount } from '@/features/connect/plan';
import { setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Card, CodeChip, Row } from './parts';

const PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function About() {
  const version = useStore((s) => s.version);
  const platform = useStore((s) => s.platform);
  const providers = useStore((s) => s.providers);
  const conn = useStore((s) => s.conn);
  const setUi = useStore((s) => s.setUi);
  // Whatever agents the bridge reports, Claude Code and Codex first.
  const agents: ProviderId[] = [...connectableAgents(providers), ...(Object.keys(providers) as ProviderId[]).filter((id) => !connectableAgents(providers).includes(id))];

  return (
    <div className="set-stack">
      <div className="about-hero card">
        <div className="about-light">
          <DitherField variant="streak" palette="mono" focus={[0.5, 1.05]} gain={0.9} cell={5} opacity={0.75} speed={0.6} />
        </div>
        <div className="about-veil" />
        <LogoMark size={48} />
        <Wordmark className="about-word" />
        <span className="about-ver num">Version {version || 'unknown'}</span>
        <p className="about-line">Claude Code and Codex in one place: every session, step and change in one timeline.</p>
      </div>

      <Card title="Agents">
        {agents.map((id) => {
          const p = providers[id];
          const plan = planLabel(signedInAccount(p)?.auth);
          return (
            <Row
              key={id}
              label={
                <span className="prov-label">
                  <ProviderMark provider={id} size={15} />
                  {PROVIDER_NAME[id]}
                </span>
              }
            >
              <span className="about-val num">{!p ? 'Checking' : !p.installed ? 'Not installed' : [plan, p.version && `Version ${p.version}`].filter(Boolean).join(' · ') || 'Installed'}</span>
            </Row>
          );
        })}
      </Card>

      <Card title="This computer">
        <Row label="Data" help="Sessions, projects and settings are stored here, on this computer only.">
          <CodeChip text="~/.sable" />
        </Row>
        <Row label="Platform">
          <span className="about-val">{PLATFORM[platform] ?? (platform || 'Unknown')}</span>
        </Row>
        <Row label="Bridge">
          <span className="about-val about-conn" data-conn={conn}>
            <span className="cc-dot" />
            {conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Connecting' : 'Disconnected'}
          </span>
        </Row>
      </Card>

      <Card>
        <Row label="Welcome">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setUi({ settings: null });
              void setSettings({ onboarded: false });
            }}
          >
            Show the welcome again
          </button>
        </Row>
      </Card>
    </div>
  );
}
