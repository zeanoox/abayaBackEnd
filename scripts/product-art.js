// Generates placeholder product illustrations (SVG) until real photography is uploaded.
// Each product colourway gets a full view and a close-up detail view.

const SKIN = '#e6d2bc';

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  const r = c(n >> 16), g = c((n >> 8) & 255), b = c(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function embroidery(accent, x, y, flip = 1) {
  const leaves = [0, 1, 2, 3, 4, 5]
    .map((i) => `<g transform="translate(${x - i * 3 * flip} ${y + i * 22})">
      <path d="M0 0c-10-3-15-12-13-18 8 2 13 10 13 18z"/><path d="M0 0c10-5 15-13 12-20-8 3-12 12-12 20z"/></g>`)
    .join('');
  return `<g stroke="${accent}" stroke-width="2" fill="none" opacity=".95">
    <path d="M${x + 6} ${y - 10}c-6 40-12 80-20 130"/>${leaves}</g>`;
}

function abaya(color, accent, style) {
  const dark = shade(color, -22), light = shade(color, 18);
  const open = style.includes('open');
  const belt = style.includes('belt');
  const cape = style.includes('cape');
  const lace = style.includes('lace');
  const pleat = style.includes('pleat');
  const butterfly = style.includes('butterfly');
  let s = '';
  // body
  s += `<path d="M300 150c-36 0-58 28-58 62 0 16 4 28 10 36-30 12-46 30-52 52L150 760c80 26 220 26 300 0L400 300c-6-22-22-40-52-52 6-8 10-20 10-36 0-34-22-62-58-62z" fill="url(#body)"/>`;
  if (open) s += `<path d="M285 250 L262 762 Q300 768 338 762 L315 250z" fill="${shade(accent, -30)}" opacity=".55"/>
    <path d="M285 250 L262 762M315 250 L338 762" stroke="${accent}" stroke-opacity=".7" stroke-width="3"/>`;
  else s += `<path d="M300 250v512" stroke="${accent}" stroke-opacity=".35" stroke-width="2.5"/>`;
  // face + hood
  s += `<ellipse cx="300" cy="208" rx="27" ry="35" fill="${SKIN}"/>`;
  // sleeves
  if (butterfly) {
    s += `<path d="M215 300C150 380 120 480 110 560c40 14 90 10 130-8l20-180z" fill="${dark}"/>
      <path d="M385 300c65 80 95 180 105 260-40 14-90 10-130-8l-20-180z" fill="${dark}"/>`;
  } else {
    s += `<path d="M212 300c-16 60-28 140-44 224 20 8 44 8 60 0l16-140z" fill="${dark}"/>
      <path d="M388 300c16 60 28 140 44 224-20 8-44 8-60 0l-16-140z" fill="${dark}"/>`;
  }
  if (cape) s += `<path d="M230 250C190 330 160 520 140 700c50 20 110 26 160 26s110-6 160-26c-20-180-50-370-90-450-20 10-45 16-70 16s-50-6-70-16z" fill="${light}" opacity=".55"/>`;
  if (pleat) s += [0, 1, 2, 3, 4].map((i) => `<path d="M${176 + i * 6} ${330 + i * 40}l52 -8" stroke="${light}" stroke-width="3"/>`).join('')
    + [0, 1, 2, 3, 4].map((i) => `<path d="M${424 - i * 6} ${330 + i * 40}l-52 -8" stroke="${light}" stroke-width="3"/>`).join('');
  if (belt) s += `<path d="M236 430 Q300 444 364 430 L366 448 Q300 462 234 448z" fill="${accent}"/><path d="M300 446 l-14 80 M300 446 l12 84" stroke="${accent}" stroke-width="6" stroke-linecap="round"/>`;
  if (lace) s += `<path d="M152 752 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0" stroke="${accent}" stroke-width="2.5" fill="none"/>
    <path d="M170 520 q12 -12 24 0 q12 -12 24 0M382 520 q12 -12 24 0 q12 -12 24 0" stroke="${accent}" stroke-width="2.5" fill="none"/>`;
  // folds
  s += `<path d="M262 340l-26 410M338 340l26 410" stroke="#000" stroke-opacity=".12" stroke-width="3" fill="none"/>`;
  if (style.includes('embroidery')) s += embroidery(accent, 196, 330);
  return s;
}

function hijab(color, accent, style) {
  const dark = shade(color, -20);
  let s = `<path d="M300 170c-60 0-92 50-92 106 0 22 6 40 14 54L170 700c80 30 180 30 260 0L378 330c8-14 14-32 14-54 0-56-32-106-92-106z" fill="url(#body)"/>
    <ellipse cx="300" cy="270" rx="44" ry="56" fill="${SKIN}"/>
    <path d="M254 312c22 34 70 34 92 0" fill="none" stroke="${color}" stroke-width="20"/>
    <path d="M240 400l-20 280M300 380v320M360 400l20 280" stroke="#000" stroke-opacity=".12" stroke-width="3"/>`;
  if (style.includes('khimar')) s += `<path d="M190 560c70 40 150 40 220 0l20 140c-80 30-180 30-260 0z" fill="${dark}" opacity=".6"/>`;
  if (style.includes('lace')) s += `<path d="M176 690 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0 q12 -14 24 0" stroke="${accent}" stroke-width="2.5" fill="none"/>`;
  return s;
}

function accessory(color, accent, style) {
  if (style.includes('belt')) {
    return `<path d="M90 380 Q300 330 510 380 L510 430 Q300 380 90 430z" fill="url(#body)"/>
      <rect x="270" y="350" width="60" height="62" rx="8" fill="none" stroke="${accent}" stroke-width="8"/>
      <path d="M180 440 l-30 160 M420 440 l34 150" stroke="${color}" stroke-width="18" stroke-linecap="round"/>`;
  }
  if (style.includes('pins')) {
    return [0, 1, 2].map((i) => `<g transform="translate(${170 + i * 130} ${360 + (i % 2) * 40})">
      <circle r="38" fill="url(#body)"/><circle r="38" fill="none" stroke="${shade(color, -40)}" stroke-width="4"/>
      <circle r="12" fill="${shade(color, 40)}"/></g>`).join('');
  }
  // underscarf / bonnet
  return `<path d="M300 260c-80 0-120 60-120 130 0 40 10 70 30 90h180c20-20 30-50 30-90 0-70-40-130-120-130z" fill="url(#body)"/>
    <path d="M210 480c60 20 120 20 180 0" stroke="${shade(color, -30)}" stroke-width="6" fill="none"/>`;
}

export function productSvg({ kind, style = '', color, accent, detail = false }) {
  const art = kind === 'hijab' ? hijab(color, accent, style) : kind === 'accessory' ? accessory(color, accent, style) : abaya(color, accent, style);
  const viewBox = detail ? (kind === 'abaya' ? '120 260 300 400' : '150 180 300 400') : '0 0 600 800';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="600" height="800" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="body" x1="0" x2="1"><stop offset="0" stop-color="${shade(color, -14)}"/><stop offset=".5" stop-color="${color}"/><stop offset="1" stop-color="${shade(color, -18)}"/></linearGradient>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${shade(accent, -14)}"/></linearGradient></defs>
<rect x="-600" y="-600" width="1800" height="2000" fill="url(#bg)"/>
<path d="M170 800V260a130 130 0 0 1 260 0v540z" fill="#fff" opacity=".28"/>
${art}
</svg>`;
}
