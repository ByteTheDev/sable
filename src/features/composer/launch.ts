import { play, reducedMotion, uiZoom } from '@/lib/motion';

/**
 * The send key answers the press in the same breath as the words leave: the disc gives a little
 * (scale .9), the arrow launches up out of it (accelerating, clipped by the disc), and the stop
 * square grows in its place, so the key the turn needs next forms where the arrow was. Drawn on a
 * copy of the disc over the real key for about 340 ms; the real stop key is the same disc with the
 * same square, so the copy simply goes. If the turn has not started by then (the stop key is not
 * showing), the copy fades instead of cutting to the empty key.
 */
export function launchKey(card: HTMLElement | null) {
  if (!card || reducedMotion()) return;
  const key = card.querySelector<HTMLElement>('.cmp-send');
  const glyph = key?.querySelector('svg');
  if (!key || !glyph) return;
  const z = uiZoom();
  const r = key.getBoundingClientRect();
  if (!r.width) return;
  const disc = document.createElement('div');
  disc.className = 'sk-launch';
  disc.setAttribute('aria-hidden', 'true');
  disc.style.cssText = `left:${r.left / z}px;top:${r.top / z}px;width:${r.width / z}px;height:${r.height / z}px;`;
  const arrow = glyph.cloneNode(true) as SVGElement;
  const sq = document.createElement('span');
  sq.className = 'sk-launch-sq';
  disc.append(arrow, sq);
  document.body.appendChild(disc);

  play(disc, [{ transform: 'scale(1)' }, { transform: 'scale(0.9)', offset: 0.28 }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' });
  play(arrow, [{ transform: 'translateY(0px)', opacity: 1 }, { transform: 'translateY(-20px)', opacity: 0.2 }], { duration: 200, delay: 30, easing: 'cubic-bezier(0.55, 0, 0.8, 0.3)', fill: 'both' });
  const grow = play(sq, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 190, delay: 150, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' });
  const done = () => {
    const stop = card.querySelector('.cmp-stop[data-on]');
    if (stop) return disc.remove();
    const out = play(disc, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'linear', fill: 'forwards' });
    if (out) out.finished.then(() => disc.remove(), () => disc.remove());
    else disc.remove();
  };
  if (grow) grow.finished.then(done, done);
  else disc.remove();
}
