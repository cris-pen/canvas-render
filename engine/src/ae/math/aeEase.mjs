// The exact inverse of easing.handlesToAeEase(), in absolute units.
//
// The emitter writes (influence, speed) into After Effects; this reads it back.
// Every conversion in the pipeline is checked against this inverse, so a sign
// error or a units slip fails a test rather than quietly producing a comp whose
// curves are subtly wrong.
import { MIN_INFLUENCE } from './easing.mjs';

export function aeEaseToHandles(outEase, inEase, v0, v1, dt) {
  const x1 = Math.max(outEase.influence, MIN_INFLUENCE) / 100;
  const runIn = Math.max(inEase.influence, MIN_INFLUENCE) / 100;
  return {
    x1,
    V1: v0 + outEase.speed * x1 * dt,
    x2: 1 - runIn,
    V2: v1 - inEase.speed * runIn * dt,
  };
}
