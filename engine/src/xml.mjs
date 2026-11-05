// Final Cut Pro 7 XML (xmeml v4). Premiere and Resolve both import it.
//
// One sequence with every rendered scene back to back on V1, in render order,
// with each scene's named sections from the board as clip markers.

import { pathToFileURL } from 'node:url';
import { parseRate } from './rates.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rateXml(rate) {
  return `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

function pathurl(file) {
  // Premiere wants file://localhost/ on macOS.
  return pathToFileURL(file).href.replace(/^file:\/\//, 'file://localhost');
}

/**
 * clips: [{ name, file, frames, width, height, rate, alpha, markers: [{ name, desc, frame }] }]
 */
export function buildXml({ name, clips }) {
  if (!clips.length) throw new Error('no clips for the timeline');
  const rate = parseRate(clips[0].rate);
  const width = Math.max(...clips.map((c) => c.width));
  const height = Math.max(...clips.map((c) => c.height));
  const total = clips.reduce((n, c) => n + c.frames, 0);
  let start = 0;
  const items = clips.map((c, i) => {
    const r = parseRate(c.rate);
    const markers = (c.markers || []).map((m) => `
            <marker><name>${esc(m.name)}</name><comment>${esc(m.desc || '')}</comment><in>${m.frame}</in><out>-1</out></marker>`).join('');
    const item = `
          <clipitem id="clipitem-${i + 1}">
            <name>${esc(c.name)}</name>
            <enabled>TRUE</enabled>
            <duration>${c.frames}</duration>
            ${rateXml(r)}
            <start>${start}</start>
            <end>${start + c.frames}</end>
            <in>0</in>
            <out>${c.frames}</out>
            <alphatype>${c.alpha ? 'straight' : 'none'}</alphatype>
            <file id="file-${i + 1}">
              <name>${esc(c.file.split('/').pop())}</name>
              <pathurl>${esc(pathurl(c.file))}</pathurl>
              ${rateXml(r)}
              <duration>${c.frames}</duration>
              <media>
                <video>
                  <samplecharacteristics>
                    ${rateXml(r)}
                    <width>${c.width}</width>
                    <height>${c.height}</height>
                    <pixelaspectratio>square</pixelaspectratio>
                  </samplecharacteristics>
                </video>
              </media>
            </file>${markers}
          </clipitem>`;
    start += c.frames;
    return item;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${esc(name)}</name>
    <duration>${total}</duration>
    ${rateXml(rate)}
    <timecode>${rateXml(rate)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rateXml(rate)}
            <width>${width}</width>
            <height>${height}</height>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>
        <track>${items}
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
        </track>
      </video>
    </media>
  </sequence>
</xmeml>
`;
}
