// Frame rates as exact rationals. 23.976 is 24000/1001, not 23.976.

export const RATES = {
  '23.976': [24000, 1001],
  '24': [24, 1],
  '25': [25, 1],
  '29.97': [30000, 1001],
  '30': [30, 1],
  '50': [50, 1],
  '59.94': [60000, 1001],
  '60': [60, 1],
};

export function parseRate(value) {
  const key = String(value ?? '').trim();
  let num; let den;
  if (RATES[key]) [num, den] = RATES[key];
  else if (/^\d+\/\d+$/.test(key)) [num, den] = key.split('/').map(Number);
  else if (Number(key) > 0) {
    const n = Number(key);
    const ntsc = Object.entries(RATES).find(([label]) => Math.abs(Number(label) - n) < 0.01);
    if (ntsc) [num, den] = ntsc[1];
    else { num = Math.round(n * 1000); den = 1000; }
  } else {
    throw new Error(`Unknown frame rate "${value}". Use one of ${Object.keys(RATES).join(', ')}.`);
  }
  const fps = num / den;
  const label = Object.keys(RATES).find((k) => RATES[k][0] === num && RATES[k][1] === den) || String(+fps.toFixed(3));
  return { num, den, fps, label, ffmpeg: `${num}/${den}`, timebase: Math.round(fps), ntsc: den === 1001 };
}

/** Time in seconds of frame n. */
export function frameTime(n, rate) {
  return (n * rate.den) / rate.num;
}

/** Number of whole frames that fit in `seconds`. */
export function frameCount(seconds, rate) {
  return Math.max(1, Math.round((seconds * rate.num) / rate.den));
}

/** Non-drop-frame timecode for frame n. */
export function timecode(n, rate) {
  const base = rate.timebase;
  const f = n % base;
  const totalSeconds = Math.floor(n / base);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return [h, m, s, f].map((v) => String(v).padStart(2, '0')).join(':');
}
