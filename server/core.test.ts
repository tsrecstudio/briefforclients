import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestions, parseModelQuestions, safeEqual } from './core.js';

test('normalizes generated questions and limits unsafe/unbounded fields', () => {
  const result = normalizeQuestions([
    { title: '  Где размещать систему? ', type: 'single', options: ['Облако', 'Свои серверы'], help: '  Учитывайте ограничения.  ', impact: 'Инфраструктура' },
    { title: 'Когда нужно запустить?', type: 'not-a-question', options: ['x'], help: 'y' },
    { title: 'Какие интеграции?', type: 'multi', options: ['ERP', 'CRM'] },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].title, 'Где размещать систему?');
  assert.deepEqual(result[0].options, ['Облако', 'Свои серверы']);
  assert.equal(result[1].type, 'textarea');
  assert.equal(result[1].options, undefined);
  assert.match(result[0].id, /^q1-/);
});

test('rejects underspecified AI question lists', () => {
  assert.throws(() => normalizeQuestions([{ title: 'One', type: 'text' }]), /минимум три/);
  assert.throws(() => normalizeQuestions('invalid'), /некорректный список/);
});

test('parses JSON object and fenced JSON returned by a model', () => {
  assert.deepEqual(parseModelQuestions('{"questions":[{"title":"A"}]}'), [{ title: 'A' }]);
  assert.deepEqual(parseModelQuestions('```json\n{"questions":[]}\n```'), []);
});

test('constant-time comparison rejects unequal lengths and values', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secrets'), false);
  assert.equal(safeEqual('secret', 'xxxxxx'), false);
});
