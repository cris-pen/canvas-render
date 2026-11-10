// Looping animations become ONE cycle of keyframes plus loopOut("cycle").
//
// The alternative -- baking every repetition across the comp -- works but is
// hostile to edit: retiming a four-second loop means moving every copy of every
// keyframe. One cycle reads as a loop in the timeline, retimes in one place, and
// converts to keyframes in After Effects whenever someone wants that.
//
// The cycle length comes from the page's own animation timing, not from looking
// for periodicity in the sampled values. The page knows its period exactly;
// inferring it from samples is guesswork that misfires on any motion that
// happens to repeat approximately.

/**
 * Which elements can be emitted as a loop, and over what window.
 *
 * A layer only qualifies when EVERY animation driving it is infinite and they
 * agree on a period. An element with one infinite and one finite animation has
 * no single cycle to repeat -- looping it would repeat the finite part too.
 */
export function detectLoops(animationTimings, captureDuration, onSkip = () => {}) {
  const loops = new Map();
  for (const [rawId, list] of Object.entries(animationTimings || {})) {
    const id = Number(rawId);
    if (!list.length) continue;

    const infinite = list.filter((a) => a.infinite && a.duration > 0);
    if (!infinite.length) continue;
    if (infinite.length !== list.length) {
      onSkip({ id, reason: 'mixes looping and one-shot animations' });
      continue;
    }
    // Alternating directions make the visible cycle twice the declared one.
    const periods = infinite.map((a) => (/alternate/i.test(String(a.direction || '')) ? a.duration * 2 : a.duration));
    const period = Math.max(...periods);
    if (periods.some((p) => Math.abs(period % p) > 1e-6 && Math.abs(p - period) > 1e-6)) {
      onSkip({ id, reason: 'looping animations have periods that do not share a cycle' });
      continue;
    }
    const start = (Math.min(...infinite.map((a) => a.birth + a.delay))) / 1000;
    const seconds = period / 1000;
    if (start + seconds > captureDuration + 1e-6) {
      onSkip({ id, reason: `one cycle is ${seconds.toFixed(2)}s but only ${captureDuration.toFixed(2)}s was captured` });
      continue;
    }
    loops.set(id, { start, period: seconds });
  }
  return loops;
}

/** Keep only the samples inside one cycle, so the emitted keyframes are one loop. */
export function windowFrames(perFrame, loop) {
  if (!loop) return perFrame;
  const end = loop.start + loop.period;
  const inside = perFrame.filter((p) => p.time >= loop.start - 1e-6 && p.time <= end + 1e-6);
  // Two samples is the minimum loopOut can work with; below that the window is
  // too short to be a loop at this frame rate and the layer stays as captured.
  return inside.length >= 2 ? inside : perFrame;
}
