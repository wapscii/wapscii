/*
  MapSCII - Terminal Map Viewer
  Search Box Module

  Draws the search prompt on the bottom line, with the places to choose
  from above it. What the keys do is in search.ts.
*/

import stringWidth from 'string-width';
import config from './config';
import { term } from './InputHandler';
import { SearchSession, type Place, type SearchProvider } from './search';

export interface SearchPromptOptions {
  suggest?: SearchProvider | null;
  providers: SearchProvider[];
}

export interface SearchPrompt {
  /** the chosen place, or null if cancelled */
  done: Promise<Place | null>;
  /** draw the prompt again (after a map frame was written over it) */
  redraw(): void;
}

const PROMPT = 'Search: ';
const HINT = 'a place, lat,lon[,zoom] or a geohash · Enter · Esc';

/** As much of text as fits in width terminal cells. */
function fit(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const cells = stringWidth(ch);
    if (used + cells > width - 1) break;
    out += ch;
    used += cells;
  }
  return out + '…';
}

export function showSearchPrompt(options: SearchPromptOptions): SearchPrompt {
  let linesDrawn = 0;
  let resolveDone: (place: Place | null) => void = () => undefined;
  const done = new Promise<Place | null>((resolve) => {
    resolveDone = resolve;
  });

  const draw = () => {
    if (!session.active) return;
    const columns = Math.max(10, config.output.columns || 80);
    const bottom = config.output.rows || 24;
    const room = Math.max(0, Math.min(10, bottom - 2));

    // the places (or a message) above the prompt line
    const lines: Array<{ text: string; selected: boolean }> = session.places.slice(0, room)
      .map((place, i) => ({ text: `${i === session.selected ? '→' : ' '} ${place.label}`, selected: i === session.selected }));
    const message = session.message || (session.places.length ? '' : (session.text.length ? '' : HINT));
    if (message && lines.length < room) lines.push({ text: message, selected: false });

    for (let i = 0; i < Math.max(linesDrawn, lines.length); i++) {
      const y = bottom - 1 - i;
      if (y < 1) break;
      term.moveTo(1, y);
      term.eraseLine();
    }
    lines.forEach((line, i) => {
      const y = bottom - lines.length + i;
      if (y < 1) return;
      term.moveTo(1, y);
      const text = fit(line.text, columns - 1);
      if (line.selected) term.bgGray.white(text);
      else term.dim(text);
    });
    linesDrawn = lines.length;

    // the prompt: scrolled so the cursor stays visible
    const before = session.text.slice(0, session.cursor);
    const budget = Math.max(1, columns - stringWidth(PROMPT) - 2);
    while (before.length && stringWidth(before.join('')) > budget) before.shift();
    const after = fit(session.text.slice(session.cursor).join(''), Math.max(1, budget - stringWidth(before.join(''))));
    term.moveTo(1, bottom);
    term.eraseLine();
    term.white(PROMPT);
    term.noFormat(before.join('') + (session.text.length > session.cursor ? after : ''));
    term.moveTo(1 + stringWidth(PROMPT) + stringWidth(before.join('')), bottom);
  };

  const session = new SearchSession({
    suggest: options.suggest,
    providers: options.providers,
    onChange: draw,
    onDone: (place) => {
      term.off('key', keyHandler);
      config.output.off('resize', draw);
      for (let i = 0; i < linesDrawn + 1; i++) {
        const y = (config.output.rows || 24) - i;
        if (y < 1) break;
        term.moveTo(1, y);
        term.eraseLine();
      }
      resolveDone(place);
    },
  });

  const keyHandler = (name: string, _matches: string[], data?: { isCharacter?: boolean }) => {
    session.key(name, data?.isCharacter ? name : undefined);
  };

  term.on('key', keyHandler);
  config.output.on('resize', draw);
  draw();

  return { done, redraw: draw };
}
