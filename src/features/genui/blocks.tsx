import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock } from '@/components/CodeBlock';
import { LazyTip } from '@/components/LazyTip';
import { useTimeline } from '@/features/timeline/ctx';
import { Icon } from '@/icons';
import { useNearViewport } from '@/lib/view-hooks';
import { useStore } from '@/state/store';
import { hashCode } from './partial';
import { WidgetView } from './WidgetBlock';

/** The info string that marks a fenced block in an answer as a widget: ```widget */
export const WIDGET_FENCE = 'widget';

/** A fenced ```widget block: the same frame as the tool, for agents that have no tool. */
export const FenceWidget = memo(function FenceWidget({ code, streaming }: { code: string; streaming: boolean }) {
  const { sessionId } = useTimeline();
  const enabled = useStore((s) => s.settings.generativeUi !== false);
  // Keyed by its start, so the key holds while the rest streams in.
  const head = code.slice(0, 240);
  const key = useMemo(() => `fence:${hashCode(head)}`, [head]);
  if (!enabled) return <CodeBlock code={code} lang="html" streaming={streaming} />;
  return <WidgetView cacheKey={key} title="" code={code} final={!streaming} sessionId={sessionId || undefined} />;
});

/** A ```mermaid block: drawn as a diagram in Sable's monochrome, with the source one click away. */
export const MermaidBlock = memo(function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref, streaming, true);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  // Only a diagram the reader watched being written gets the reveal; history just appears.
  const live = useRef(streaming);
  if (streaming) live.current = true;

  useEffect(() => {
    if (!near || streaming) return;
    let alive = true;
    setError(null);
    import('./mermaid')
      .then((m) => m.renderMermaid(code))
      .then(
        (out) => alive && setSvg(out),
        (err: unknown) => alive && setError(String((err as Error)?.message ?? err).split('\n')[0].slice(0, 160)),
      );
    return () => {
      alive = false;
    };
  }, [near, streaming, code]);

  const key = useMemo(() => `mm:${hashCode(code)}`, [code]);
  const page = useMemo(() => (svg ? `<div style="display:flex;justify-content:center">${svg}</div>` : ''), [svg]);

  if (streaming || error || source) {
    const back = !streaming && svg && source && (
      <LazyTip label="Show the diagram" side="top">
        <button type="button" className="icon-btn cb-btn" aria-label="Show the diagram" onClick={() => setSource(false)}>
          <Icon name="tree" size={13} />
        </button>
      </LazyTip>
    );
    return (
      <div className="mm" ref={ref}>
        {error && <p className="mm-error">This diagram could not be drawn: {error}</p>}
        <CodeBlock code={code} lang="mermaid" title={streaming || error ? undefined : 'Diagram'} streaming={streaming} actions={back || undefined} />
      </div>
    );
  }
  // Until Mermaid has drawn it, the frame holds the diagram's place (its remembered height) with a
  // skeleton; then the diagram is revealed in the same frame.
  return (
    <div className="mm" ref={ref}>
      <WidgetView
        cacheKey={key}
        title="Diagram"
        code={page}
        final={!!svg}
        reveal={live.current}
        copyText={code}
        actions={
          <LazyTip label="Show code" side="top">
            <button type="button" className="icon-btn gw-btn" aria-label="Show code" onClick={() => setSource(true)}>
              <Icon name="code" size={14} />
            </button>
          </LazyTip>
        }
      />
    </div>
  );
});
