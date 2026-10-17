import bidiFactory from 'bidi-js';
// CommonJS packages: Node's ESM loader only gives them a default export
import arabicPersianReshaper from 'arabic-persian-reshaper';
import stringWidth from 'string-width';

const { ArabicShaper } = arabicPersianReshaper;

const bidi = bidiFactory();
const RTL_RE = /[\u0590-\u08ff\ufb1d-\ufefc]/;
const ARABIC_RE = /[\u0600-\u06ff\ufb50-\ufefc]/;

// C0 and C1 controls, DEL, and the bidi embeddings, overrides and isolates
// eslint-disable-next-line no-control-regex -- finding control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Text from tiles, a search or a web service, safe to print: control
 * characters become spaces, so that a name can't carry an escape sequence
 * (a window title, a clipboard write) into the terminal.
 */
export function terminalSafe(text: unknown): string {
  return String(text).replace(CONTROL_RE, ' ');
}

export function hasRightToLeftText(text: string): boolean {
  return RTL_RE.test(text);
}

export function shapeLineForTerminal(line: string): string {
  if (!hasRightToLeftText(line)) return line;

  const shaped = ARABIC_RE.test(line) ? ArabicShaper.convertArabic(line) : line;
  const levels = bidi.getEmbeddingLevels(shaped);
  const chars = shaped.split('');
  const mirrored = bidi.getMirroredCharactersMap(shaped, levels);

  mirrored.forEach((value, key) => {
    chars[key] = value;
  });

  bidi.getReorderSegments(shaped, levels).forEach(([start, end]) => {
    const reversed = chars.slice(start, end + 1).reverse();
    chars.splice(start, reversed.length, ...reversed);
  });

  return chars.join('');
}

export function shapeTextForTerminal(text: string): string {
  return String(text)
    .split('\n')
    .map((line) => shapeLineForTerminal(terminalSafe(line)))
    .join('\n');
}

export function displayLines(text: string): string[] {
  return shapeTextForTerminal(text).split('\n');
}

export function wrapText(text: string, maxWidth: number): string {
  if (!maxWidth || maxWidth < 1) return text;

  return String(text)
    .split('\n')
    .flatMap((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) return [''];

      const lines: string[] = [];
      let line = '';

      words.forEach((word) => {
        const candidate = line ? `${line} ${word}` : word;

        if (line && stringWidth(candidate) > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      });

      if (line) lines.push(line);
      return lines;
    })
    .join('\n');
}

export function formatLabelText(text: string, maxWidth: number): string {
  return shapeTextForTerminal(wrapText(text, maxWidth));
}
