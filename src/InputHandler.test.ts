import { describe, expect, test } from 'bun:test';
import InputHandler, { normalizeKeyName, term } from './InputHandler';

describe('normalizeKeyName', () => {
  test('keeps the case of single printable characters so uppercase bindings work', () => {
    expect(normalizeKeyName('S')).toBe('S');
    expect(normalizeKeyName('R')).toBe('R');
    expect(normalizeKeyName('s')).toBe('s');
    expect(normalizeKeyName('r')).toBe('r');
    expect(normalizeKeyName('a')).toBe('a');
    expect(normalizeKeyName('A')).toBe('A');
    expect(normalizeKeyName('?')).toBe('?');
  });

  test('maps terminal-kit special keys to canonical names', () => {
    expect(normalizeKeyName('UP')).toBe('up');
    expect(normalizeKeyName('DOWN')).toBe('down');
    expect(normalizeKeyName('LEFT')).toBe('left');
    expect(normalizeKeyName('RIGHT')).toBe('right');
    expect(normalizeKeyName('ESCAPE')).toBe('escape');
  });

  test('maps CTRL_C to the quit binding', () => {
    expect(normalizeKeyName('CTRL_C')).toBe('q');
  });

  test('lowercases other multi-character key names', () => {
    expect(normalizeKeyName('ENTER')).toBe('enter');
    expect(normalizeKeyName('BACKSPACE')).toBe('backspace');
    expect(normalizeKeyName('F1')).toBe('f1');
  });
});

describe('InputHandler', () => {
  test('asks for mouse reports, unless the mouse stays the terminal\'s', () => {
    const grabbed: unknown[] = [];
    const original = term.grabInput;
    term.grabInput = (options) => {
      grabbed.push(options);
    };
    try {
      const withMouse = new InputHandler(process.stdin, process.stdout);
      withMouse.start(() => undefined);
      withMouse.stop();
      const withoutMouse = new InputHandler(process.stdin, process.stdout);
      withoutMouse.start(() => undefined, { mouse: false });
      withoutMouse.stop();
    } finally {
      term.grabInput = original;
    }
    expect(grabbed).toEqual([{ mouse: 'motion' }, false, true, false]);
  });
});
