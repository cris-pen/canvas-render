/* eslint-disable no-underscore-dangle */
// Make canvas content readable after the fact.
//
// A WebGL drawing buffer is thrown away at the end of the frame that drew it, so
// reading it later gives a blank image -- with no error, which is the awkward
// part: the capture succeeds and every frame is empty. Measured on this
// Chromium: a same-task toDataURL returns 1526 bytes of triangle, a later-task
// read returns an 806-byte blank.
//
// Two defences, because either alone has a failure mode:
//   * preserveDrawingBuffer keeps the buffer alive between tasks. It costs a
//     little performance, which does not matter for an offline capture.
//   * the probe also snapshots canvases in the SAME task as the rAF flush that
//     drew them, so content survives even if a context was created before this
//     patch could apply (an inline script in <head>, say).
(() => {
  if (window.__d2aeCanvasPatched) return;
  window.__d2aeCanvasPatched = true;
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function patched(type, attrs) {
    if (/webgl|experimental-webgl/i.test(String(type))) {
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    }
    return original.call(this, type, attrs);
  };
})();
