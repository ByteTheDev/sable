import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { conn, parsePairLink, type PairOffer } from '@m/lib/conn';
import { askNotifications, deviceName, haptic } from '@m/lib/native';
import { Field } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { LogoMark } from '@m/ui/marks';
import { Scanner } from './Scanner';

type Step = { kind: 'idle' } | { kind: 'connecting'; offer: PairOffer } | { kind: 'waiting'; offer: PairOffer } | { kind: 'error'; text: string };

/** First run (or after the desktop removed this phone): pair by scanning the desktop's code or pasting its link. */
export function Pair({ link, onLinkUsed, denied }: { link?: string | null; onLinkUsed: () => void; denied?: string }) {
  const [step, setStep] = useState<Step>(denied ? { kind: 'error', text: denied } : { kind: 'idle' });
  const [scan, setScan] = useState(false);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const busy = step.kind === 'connecting' || step.kind === 'waiting';
  const inFlight = useRef(false);

  const start = async (raw: string) => {
    if (inFlight.current) return;
    const offer = parsePairLink(raw);
    if (!offer) {
      haptic('warning');
      setStep({ kind: 'error', text: 'That is not a Sable pairing link' });
      return;
    }
    inFlight.current = true;
    setScan(false);
    setPaste(false);
    setStep({ kind: 'connecting', offer });
    try {
      await conn.pair(offer, await deviceName(), () => setStep({ kind: 'waiting', offer }));
      haptic('success');
      // The one moment to ask: right after pairing, so a turn that ends while the phone is away can say so.
      void askNotifications();
    } catch (err) {
      haptic('deny');
      setStep({ kind: 'error', text: (err as Error).message });
    } finally {
      inFlight.current = false;
    }
  };

  useEffect(() => {
    if (link) {
      onLinkUsed();
      void start(link);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  return (
    <div className="screen pair">
      <Field palette="ember" amount={1} focusY={1.08} spread={0.7} />
      <div className="pair-veil" />
      <div className="pair-main">
        <motion.div className="pair-mark" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
          <LogoMark size={44} cells />
        </motion.div>
        <motion.h1 className="pair-title" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.06, ease: [0.2, 0.8, 0.2, 1] }}>
          Sable
        </motion.h1>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={step.kind}
            className="pair-line"
            data-tone={step.kind === 'error' ? 'error' : step.kind === 'waiting' ? 'waiting' : undefined}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {step.kind === 'idle' && 'Open Settings › Phone on your computer and scan the code.'}
            {step.kind === 'connecting' && `Reaching ${step.offer.name ?? 'your computer'}`}
            {step.kind === 'waiting' && `Allow this phone on ${step.offer.name ?? 'your computer'}`}
            {step.kind === 'error' && step.text}
          </motion.p>
        </AnimatePresence>
      </div>

      <div className="pair-actions">
        <AnimatePresence initial={false}>
          {paste && (
            <motion.form
              className="pair-paste"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ type: 'spring', stiffness: 460, damping: 40 }}
              onSubmit={(e) => {
                e.preventDefault();
                void start(text);
              }}
            >
              <input
                className="field-input"
                autoFocus
                placeholder="sable://pair?…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Pairing link"
              />
              <button type="submit" className="btn" disabled={!text.trim()}>
                Pair
              </button>
            </motion.form>
          )}
        </AnimatePresence>
        <button type="button" className="btn btn-primary btn-lg" disabled={busy} data-busy={busy || undefined} onClick={() => (haptic('tap'), setScan(true))}>
          {busy ? <span className="dots" aria-label="Pairing" /> : (
            <>
              <Icon name="qr" size={20} /> Scan code
            </>
          )}
        </button>
        <button type="button" className="btn btn-lg glass" disabled={busy} onClick={() => setPaste((v) => !v)}>
          Paste link
        </button>
      </div>

      <AnimatePresence>{scan && <Scanner onCode={(c) => void start(c)} onClose={() => setScan(false)} />}</AnimatePresence>
    </div>
  );
}
