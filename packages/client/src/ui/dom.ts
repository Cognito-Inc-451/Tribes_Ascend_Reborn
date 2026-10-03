type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string };

/** Tiny DOM builder. Strings are always inserted as text nodes (never HTML) so player text cannot inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** What each physical key prints on this keyboard layout (AZERTY's "KeyW" is "z"): Keyboard API, then learnt from key presses. */
const layoutKeys = new Map<string, string>();
const LAYOUT_CODE = /^Key|^(Semicolon|Comma|Period|Slash|Quote|BracketLeft|BracketRight|Backquote|Backslash|Minus|Equal|IntlBackslash)$/;
void (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard?.getLayoutMap?.()
  .then((m) => m.forEach((v, k) => { if (!layoutKeys.has(k)) layoutKeys.set(k, v); })).catch(() => { /* not allowed (iframe) */ });
window.addEventListener('keydown', (e) => {
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && LAYOUT_CODE.test(e.code)) layoutKeys.set(e.code, e.key);
}, true);

/** The character a physical key types on the user's layout, when known. */
export const layoutChar = (code: string): string | undefined => (LAYOUT_CODE.test(code) ? layoutKeys.get(code) : undefined);

export const keyLabel = (code: string): string => {
  if (!code) return '—';
  const ch = layoutChar(code);
  if (ch && ch.trim()) return ch.toUpperCase();
  return code
    .replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace('Mouse0', 'LMB').replace('Mouse1', 'MMB').replace('Mouse2', 'RMB')
    .replace('ControlLeft', 'L-Ctrl').replace('ShiftLeft', 'L-Shift').replace('AltLeft', 'L-Alt').replace('Backquote', '~').replace('Space', 'Space');
};
