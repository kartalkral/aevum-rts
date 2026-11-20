import { el } from './ui-shared.js';

const DOCS = 'https://github.com/kartalkral/aevum-rts/blob/main';

export function projectLinks() {
  const nav = el('nav', 'project-links');
  nav.setAttribute('aria-label', 'Lisans ve kaynaklar');
  for (const [label, href] of [
    ['Kaynak kodu', './source'],
    ['Kod lisansı', `${DOCS}/LICENSE`],
    ['Varlık lisansları', `${DOCS}/assets/LICENSE.md`],
    ['Atıflar', `${DOCS}/assets/CREDITS.md`],
  ]) {
    const a = el('a');
    a.textContent = label;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    nav.append(a);
  }
  return nav;
}
