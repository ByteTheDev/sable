import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { pushBack } from '@m/lib/back';
import { Icon } from '@m/ui/icons';

/** The camera, looking for a Sable pairing code (decoded on the phone with jsQR, a few times a second). */
export function Scanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => pushBack(() => (onClose(), true)), [onClose]);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      const v = video.current;
      if (stopped || !v || !ctx) return;
      if (v.readyState >= 2 && v.videoWidth) {
        const w = 480;
        const h = Math.round((v.videoHeight / v.videoWidth) * w);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const code = jsQR?.(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
        if (code?.data && /^sable:\/\/pair\?/i.test(code.data)) {
          stopped = true;
          onCode(code.data);
          return;
        }
      }
      timer = window.setTimeout(tick, 140);
    };
    let jsQR: typeof import('jsqr').default | undefined;
    (async () => {
      try {
        jsQR = (await import('jsqr')).default;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play().catch(() => {});
        }
        tick();
      } catch {
        setError('Sable cannot use the camera. Paste the link instead.');
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <motion.div className="scanner" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
      <video ref={video} className="scanner-video" playsInline muted />
      <div className="scanner-frame" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>
      {error && <p className="scanner-error">{error}</p>}
      <button type="button" className="scanner-close icon-btn glass" onClick={onClose} aria-label="Close the camera">
        <Icon name="x" size={20} />
      </button>
    </motion.div>
  );
}
