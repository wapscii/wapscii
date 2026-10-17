import { describe, expect, test } from 'bun:test';
import InputHandler, { addRxvtShiftArrows, normalizeKeyName, term } from './InputHandler';

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

describe('rxvt mouse motion', () => {
  test('is asked for on rxvt, and turned off again', () => {
    const written: string[] = [];
    const originalGrab = term.grabInput;
    const originalWrite = process.stdout.write;
    const originalTerm = process.env.TERM;
    term.grabInput = () => undefined;
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      process.env.TERM = 'rxvt-unicode-256color';
      const handler = new InputHandler(process.stdin, process.stdout);
      handler.start(() => undefined);
      handler.stop();
      const noMouse = new InputHandler(process.stdin, process.stdout);
      noMouse.start(() => undefined, { mouse: false });
      noMouse.stop();
      process.env.TERM = 'xterm-256color';
      const xterm = new InputHandler(process.stdin, process.stdout);
      xterm.start(() => undefined);
      xterm.stop();
    } finally {
      term.grabInput = originalGrab;
      process.stdout.write = originalWrite;
      if (originalTerm === undefined) delete process.env.TERM;
      else process.env.TERM = originalTerm;
    }
    expect(written).toEqual(['\x1b[?1003h', '\x1b[?1003l']);
  });
});

describe('terminal-kit key map', () => {
  test('learns rxvt\'s Shift+arrows, without replacing known keys', () => {
    const known = { code: '\x1b[c', name: 'SOMETHING', matches: ['SOMETHING'] };
    const terminal = { rKeymap: { 3: { '\x1b[c': known } as Record<string, unknown> } };
    addRxvtShiftArrows(terminal);
    expect(terminal.rKeymap[3]['\x1b[a']).toEqual({ code: '\x1b[a', name: 'SHIFT_UP', matches: ['SHIFT_UP'] });
    expect(terminal.rKeymap[3]['\x1b[b']).toMatchObject({ name: 'SHIFT_DOWN' });
    expect(terminal.rKeymap[3]['\x1b[c']).toBe(known);
  });
});
