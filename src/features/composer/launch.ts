import { play, reducedMotion, spring, uiZoom } from '@/lib/motion';
import { RELEASE } from './flight';

/**
 * The send key answers the press in the same beat as the words leave (`RELEASE`, flight.ts): the
 * disc gives (scale .88) while the words gather, then on the release the arrow launches up out of
 * it (accelerating, clipped by the disc), the whole composer takes the recoil (a 2.5 px dip that
 * springs back), and the stop square grows where the arrow was. Drawn on a
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

  // The recoil: the card dips as the words leave it and springs back; the disc copy rides along.
  const back = spring(420, 24);
  const recoil: Keyframe[] = [{ translate: '0 2.5px' }, { translate: '0 0' }];
  const kick = { duration: back.duration, delay: RELEASE, easing: back.easing };
  play(card, recoil, kick);
  play(disc, recoil, kick);
  play(disc, [{ scale: '1' }, { scale: '0.88', offset: 0.2 }, { scale: '1' }], { duration: 300, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' });
  play(arrow, [{ transform: 'translateY(0px)', opacity: 1 }, { transform: 'translateY(-20px)', opacity: 0.2 }], { duration: 180, delay: RELEASE, easing: 'cubic-bezier(0.55, 0, 0.8, 0.3)', fill: 'both' });
  const grow = play(sq, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 190, delay: RELEASE + 110, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' });
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
