import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentTriggers, dmText, fill, followUpReply, matchesKeyword, pickCommentReply, privateReplyAllowed, withinWindow, EMPTY_AUTOMATION, type AutomationConfig } from '../shared/automation.ts';

const cfg: AutomationConfig = {
  ...EMPTY_AUTOMATION,
  keywords: ['GUIA', 'quero o guia'],
  dm: 'Oi, {nome}! Segue o guia.',
  link: { label: 'Baixe aqui', url: 'https://exemplo.com/guia' },
  followUp: { question: 'Quer o checklist também? Responda SIM', options: [{ keyword: 'sim', reply: 'Aqui está o checklist!' }] },
};

test('palavra-chave ignora maiúsculas, acentos e emojis', () => {
  assert.equal(matchesKeyword('Quero o GUIA!! 🙏', ['guia'], 'contains'), 'guia');
  assert.equal(matchesKeyword('guía', ['GUIA'], 'contains'), 'GUIA');
  assert.equal(matchesKeyword('guiado por mim', ['guia'], 'contains'), null, 'não casa parte de outra palavra');
  assert.equal(matchesKeyword('guia sim', ['guia'], 'exact'), null);
  assert.equal(matchesKeyword(' GUIA ', ['guia'], 'exact'), 'guia');
});

test('respeita as publicações escolhidas', () => {
  const only = { ...cfg, mediaIds: ['m1'] };
  assert.ok(commentTriggers(only, 'GUIA', 'm1'));
  assert.equal(commentTriggers(only, 'GUIA', 'm2'), null);
});

test('DM com nome, link e pergunta de continuidade', () => {
  const t = dmText(cfg, { nome: 'Maria Silva', usuario: 'maria' });
  assert.match(t, /^Oi, Maria! Segue o guia\./);
  assert.match(t, /Baixe aqui: https:\/\/exemplo\.com\/guia/);
  assert.match(t, /Responda SIM$/);
  assert.equal(fill('Oi {nome}', { usuario: 'joao' }), 'Oi joao');
});

test('continuidade reconhece a resposta', () => {
  assert.equal(followUpReply(cfg, 'Sim!!')?.reply, 'Aqui está o checklist!');
  assert.equal(followUpReply(cfg, 'não'), null);
});

test('alterna respostas públicas', () => {
  const c = { ...cfg, commentReplies: ['A', 'B'] };
  assert.notEqual(pickCommentReply(c, 0, {}), pickCommentReply(c, 1, {}));
});

test('janelas da Meta: 24 h para DM e 7 dias para resposta privada', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.ok(withinWindow('2026-10-23T00:00:00Z', now));
  assert.ok(!withinWindow('2026-10-21T00:00:00Z', now));
  assert.ok(!withinWindow(null, now));
  assert.ok(privateReplyAllowed('2026-10-20T00:00:00Z', now));
  assert.ok(!privateReplyAllowed('2026-10-10T00:00:00Z', now));
});
