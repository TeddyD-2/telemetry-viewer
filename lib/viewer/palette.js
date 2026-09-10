/* Colour that more than one view draws with.

   The ramp is one hue, lightness stepping 0.53 -> 0.91, anchored dark-to-light because the
   surface is dark. Not the turbo/rainbow ramp motorsport tools habitually use for track
   maps: a rainbow has no perceptual order (readers cannot say which of green and orange is
   "more") and it collapses under red-green colour blindness. A single-hue ramp orders
   itself. The darkest step is held at 3.2:1 against the surface, because these are thin
   lines and small points rather than filled areas, and a mark you cannot see reads as
   missing data rather than as a low value. */
export const RAMP = ['#256abf','#2a78d6','#3987e5','#5598e7','#6da7ec','#86b6ef','#9ec5f4','#b7d3f6','#cde2fb'];
export const rampIndex = f => Math.max(0, Math.min(RAMP.length - 1, Math.floor(f * RAMP.length)));
export const rampAt = f => RAMP[rampIndex(f)];

/* Hex or rgb(): extended slots are themselves tints, and they get tinted again. */
const rgb = col => {
  const m = /rgba?\(([^)]+)\)/.exec(col);
  if (m) return m[1].split(',').slice(0, 3).map(Number);
  const h = col.replace('#', '');
  const v = parseInt(h.length === 3 ? h.replace(/./g, c => c + c) : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
export const withAlpha = (hex, a) => `rgba(${rgb(hex).join(',')},${a})`;
/* Toward white by f. An imported session's trace is its channel's colour, lighter and
   dashed: still visibly the same channel, never mistaken for this session's. */
export const tint = (hex, f) => `rgb(${rgb(hex).map(c => Math.round(c + (255 - c) * f)).join(',')})`;

/* One dash pattern per imported session, in the order they were added. Solid is this
   session's; the rest are chosen to stay distinct at 1.5 px. */
export const SESSION_DASH = [[7, 4], [2, 3], [11, 3, 2, 3], [4, 6]];
