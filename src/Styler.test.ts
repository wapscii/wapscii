import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import Styler, { type MapStyle } from './Styler';
import { generateDrawOrder } from './drawOrder';

const feature = (properties: Record<string, string | number>, type = 'Point') =>
  ({ properties: { $type: type, ...properties } }) as never;

describe('Styler filters', () => {
  test('"has" asks whether the key is there, whatever its value', () => {
    const styler = new Styler({
      name: 'test',
      layers: [
        { id: 'with', type: 'symbol', 'source-layer': 'l', filter: ['has', 'layer'] },
        { id: 'without', type: 'symbol', 'source-layer': 'l', filter: ['!has', 'layer'] },
      ],
    } as unknown as MapStyle);
    expect((styler.getStyleFor('l', feature({ layer: 0 })) || { id: '' }).id).toBe('with');
    expect((styler.getStyleFor('l', feature({ layer: '' })) || { id: '' }).id).toBe('with');
    expect((styler.getStyleFor('l', feature({})) || { id: '' }).id).toBe('without');
  });
});

describe('the dark style', () => {
  const style = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'styles', 'dark.json'), 'utf8')) as MapStyle;
  const styler = new Styler(style);
  const id = (layer: string, properties: Record<string, string | number>, type = 'Polygon') =>
    (styler.getStyleFor(layer, feature(properties, type)) || { id: null }).id;

  test('fills the classes OpenMapTiles has', () => {
    expect(id('park', { class: 'nature_reserve' })).toBe('park_natural_reserve');
    expect(id('landcover', { class: 'grass', subclass: 'park' })).toBe('landcover_green_space');
  });

  test('labels airports and peaks, and draws their layers', () => {
    expect(id('aerodrome_label', { iata: 'MUC', name: 'München' }, 'Point')).toBe('aerodrome_label');
    expect(id('mountain_peak', { name: 'Zugspitze', ele: 2962 }, 'Point')).toBe('mountain_peak');
    expect(generateDrawOrder(12)).toContain('aerodrome_label');
    expect(generateDrawOrder(12)).toContain('mountain_peak');
  });
});
