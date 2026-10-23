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

import { DEFAULT_GATE, deliveryMessage, gateMessage, isButtonReply, nextAfterClick, openingMessage, usesButtonFlow } from '../shared/automation.ts';

test('fluxo com botão: convite → clique → (segue?) → entrega com link em botão', () => {
  const c: AutomationConfig = { ...cfg, button: { label: 'Quero o link' }, delivery: 'Aqui está, {nome}!', followGate: { ...DEFAULT_GATE } };
  assert.ok(usesButtonFlow(c));
  const open = openingMessage(c, { nome: 'Ana Souza' }, 'f1');
  assert.equal(open.text, 'Oi, Ana! Segue o guia.');
  assert.deepEqual(open.buttons, [{ type: 'postback', title: 'Quero o link', payload: 'orbit:f1:open' }]);
  assert.ok(isButtonReply(c, 'opened', 'Quero o link'));
  assert.ok(!isButtonReply(c, 'opened', 'oi'));
  assert.deepEqual(nextAfterClick(c, 'opened', false, 0), { send: 'gate', stage: 'gated' });
  assert.deepEqual(nextAfterClick(c, 'opened', null, 0), { send: 'gate', stage: 'gated' }); // sem confirmação, não entrega
  assert.ok(isButtonReply(c, 'gated', 'Estou seguindo'));
  assert.ok(isButtonReply(c, 'gated', 'já segui!'));
  assert.deepEqual(nextAfterClick(c, 'gated', false, 1), { send: 'gate_retry', stage: 'gated' });
  assert.deepEqual(nextAfterClick(c, 'gated', true, 2), { send: 'delivery', stage: 'delivered' });
  assert.equal(nextAfterClick(c, 'gated', false, 5).send, 'none');
  assert.equal(gateMessage(c, 'f1', true).text, DEFAULT_GATE.notYet);
  const d = deliveryMessage(c, { nome: 'Ana' });
  assert.equal(d.buttons?.[0].type, 'web_url');
  assert.ok(d.text.startsWith('Aqui está, Ana!'));
  // sem trava: clique entrega direto
  assert.equal(nextAfterClick({ ...c, followGate: null }, 'opened', null, 0).send, 'delivery');
});
