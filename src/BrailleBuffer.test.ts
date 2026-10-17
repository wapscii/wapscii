import { describe, expect, test } from 'bun:test';
import BrailleBuffer from './BrailleBuffer';

describe('BrailleBuffer text', () => {
  test('never prints control characters from labels (escape sequences in tile data)', () => {
    const buffer = new BrailleBuffer(80, 16);
    buffer.writeText('Evil\u001b]0;pwned\u0007Town\u009b2J', 10, 4, 15, false);
    const frame = buffer.frame();
    expect(frame).not.toContain('\u001b]0;pwned');
    expect(frame).not.toContain('\u0007');
    expect(frame).not.toContain('\u009b');
    expect(frame).toContain('Evil');
  });

  test('keeps multi-line labels', () => {
    const buffer = new BrailleBuffer(80, 16);
    buffer.writeText('Upper\nLower', 10, 0, 15, false);
    const lines = buffer.frame().split('\n');
    expect(lines.some((line) => line.includes('Upper'))).toBe(true);
    expect(lines.some((line) => line.includes('Lower'))).toBe(true);
  });
});
