// Legenda profissional: regras de montagem das cartelas (ESPECIFICACAO_LEGENDAS.md, seção 2) e layout letra a letra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCartelas, layoutLetters, pickEmphasis, proCaptionEvents, type ProWord } from '../shared/pro-captions.ts';

const seq = (text: string, t0 = 0, dur = 0.3, gap = 0.05): ProWord[] => {
  let t = t0;
  return text.split(' ').map((w) => {
    const r = { text: w, start: t, end: t + dur };
    t += dur + gap;
    return r;
  });
};

test('linha 1 até 20 caracteres, depois linha 2 (que entra quando é falada)', () => {
  const c = buildCartelas(seq('Essa é a parte que mais importa no processo'));
  assert.equal(c[0].l1.join(' '), 'Essa é a parte que');
  assert.ok(c[0].l1.join(' ').length <= 20 && c[0].l2.join(' ').length <= 20);
  assert.equal(c[0].l2[0], 'mais');
  assert.ok(c[0].l2s! > c[0].s);
});

test('pausa maior que 0,35 s e ponto final (com linha 2) fecham a cartela', () => {
  const words = [...seq('Primeira frase aqui', 0), ...seq('depois da pausa', 2)];
  assert.equal(buildCartelas(words).length, 2);
  const p = buildCartelas(seq('Essa é a parte que mais importa. Agora outra'));
  assert.equal(p[0].l2.join(' '), 'mais importa.');
  assert.equal(p[1].l1[0], 'Agora');
});

test('ênfase: *palavra, sem vírgula/ponto, só entra se ainda não houver linha 2', () => {
  const c = buildCartelas(seq('Isso é *resultados, de verdade'));
  assert.deepEqual(c[0].l1, ['Isso', 'é']);
  assert.equal(c[0].emph?.w, 'resultados');
  assert.deepEqual(c[0].l2, ['de', 'verdade']);
  const d = buildCartelas(seq('Essa é a parte que mais *importa'));
  assert.equal(d.length, 2); // a cartela 1 já tinha linha 2 → ênfase abre outra
  assert.equal(d[1].emph?.w, 'importa');
});

test('| força cartela nova; fim = última palavra + 0,25 s; última ganha +0,4 s', () => {
  const words = seq('Pergunta curta |Resposta dele');
  const c = buildCartelas(words);
  assert.equal(c.length, 2);
  assert.equal(c[1].l1[0], 'Resposta');
  assert.equal(c[0].e, c[1].s); // buraco < 0,3 s até a próxima é preenchido
  assert.ok(Math.abs(c[1].e - (words[3].end + 0.4)) < 1e-9);
});

test('letras quase encostando: tracking negativo e linha centralizada', () => {
  const ls = layoutLetters('Linha1', 540, 'eficiência', 1, 980);
  const span = ls[ls.length - 1].x - ls[0].x;
  assert.ok(span > 200 && span < 520);
  const mid = (ls[0].x + ls[ls.length - 1].x) / 2;
  assert.ok(Math.abs(mid - 540) < 40);
  // palavra de ênfase enorme é reduzida até caber em 980 px
  const big = layoutLetters('Enfase', 540, 'transformaçãodigitalcompleta', 1, 980);
  assert.ok(big[0].scale.includes('fscx') && big[0].x >= 540 - 490 - 2);
});

test('eventos: sombra + letra por caractere, fade 90/110 e posição y1 = 1240 em 1080×1920', () => {
  const ev = proCaptionEvents(seq('Olá pessoal'), { posY: 0.646 }, 1080, 1920, (t) => t.toFixed(2));
  assert.equal(ev.length, 2 * 'Olápessoal'.length);
  assert.ok(ev.every((e) => e.includes('\\fad(90,110)')));
  assert.ok(ev.some((e) => /\\pos\(\d+,1240\)/.test(e)));
  assert.ok(ev.some((e) => e.includes('\\1a&HA0&\\blur9')));
});

test('ênfase automática ~1 a cada 7 s, palavras longas e não genéricas', () => {
  const words = seq(Array.from({ length: 60 }, (_, i) => (i % 10 === 7 ? 'resultados.' : i % 5 === 0 ? 'porque' : 'a')).join(' '), 0, 0.3, 0.05);
  const picks = pickEmphasis(words);
  assert.ok(picks.length >= 2);
  assert.ok(picks.every((i) => words[i].text === 'resultados.'));
});
