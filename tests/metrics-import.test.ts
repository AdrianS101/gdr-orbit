import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseMetricsCsv, parseNumber } from '../shared/metrics-import.ts';

test('números em formatos brasileiros e abreviados; vazio não vira zero', () => {
  assert.equal(parseNumber('1.234'), 1234);
  assert.equal(parseNumber('12,5 mil'), 12500);
  assert.equal(parseNumber('3,4K'), 3400);
  assert.equal(parseNumber('2.5M'), 2500000);
  assert.equal(parseNumber('87'), 87);
  assert.equal(parseNumber(''), null);
});

test('datas dd/mm/aaaa e ISO', () => {
  assert.equal(parseDate('23/10/2026')?.slice(0, 10), new Date(2026, 9, 23, 12).toISOString().slice(0, 10));
  assert.ok(parseDate('2026-10-23'));
  assert.equal(parseDate('ontem'), null);
});

test('CSV com cabeçalho em português, aspas e linhas inválidas', () => {
  const csv = 'Data;Link;Tipo;Legenda;Visualizações;Curtidas;Comentários\n23/10/2026;https://x/1;Vídeo;"Olá; mundo";12,5 mil;830;\nxx;https://x/2;foto;a;1;2;3\n';
  const r = parseMetricsCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].caption, 'Olá; mundo');
  assert.equal(r.rows[0].type, 'reel');
  assert.deepEqual(r.rows[0].metrics, { views: 12500, likes: 830 });
  assert.equal(r.errors.length, 1);
});
