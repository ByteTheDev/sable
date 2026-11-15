import { setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Segmented } from '@/ui';
import { Background } from './Background';
import { Card, Row } from './parts';

const SCALES = [0.9, 1, 1.1, 1.2];

export function Appearance() {
  const fontScale = useStore((s) => s.settings.fontScale);

  return (
    <div className="set-stack">
      <Background />
      <Card>
        <Row label="Interface size">
          <Segmented
            id="set-scale"
            value={String(nearest(fontScale))}
            onChange={(v) => setSettings({ fontScale: Number(v) })}
            options={SCALES.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` }))}
          />
        </Row>
      </Card>
    </div>
  );
}

function nearest(scale: number) {
  return SCALES.reduce((a, b) => (Math.abs(b - scale) < Math.abs(a - scale) ? b : a), 1);
}
