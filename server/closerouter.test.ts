import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from './index.js';

test('brief generation calls CloseRouter chat completions with the configured model and key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdis-router-'));
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  let authorization = '';
  let requestBody: any;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(input);
    authorization = new Headers(init?.headers).get('Authorization') || '';
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: [
      { title: 'Где будут размещены данные?', type: 'single', options: ['Облако', 'Свои серверы', 'Пока не знаем'], impact: 'Инфраструктура' },
      { title: 'С какими системами нужна интеграция?', type: 'textarea', impact: 'Интеграции' },
      { title: 'Сколько пользователей будет работать?', type: 'text', impact: 'Нагрузка' },
    ] }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const { app, db } = createApp({ dbPath: path.join(dir, 'test.sqlite'), uploadDir: path.join(dir, 'uploads'), adminPassword: 'admin', sessionSecret: 'secret', closeRouterApiKey: 'closerouter_test_key', model: 'anthropic/claude-sonnet-5.5' });
  try {
    const login = await request(app).post('/api/admin/login').send({ password: 'admin' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const created = await request(app).post('/api/admin/briefs').set('Cookie', cookie).send({ company: 'CloseRouter клиент', description: 'Производственный процесс', request: 'Упростить обработку заказов' });
    assert.equal(created.status, 201);
    assert.equal(calledUrl, 'https://api.closerouter.dev/v1/chat/completions');
    assert.equal(authorization, 'Bearer closerouter_test_key');
    assert.equal(requestBody.model, 'anthropic/claude-sonnet-5.5');
    assert.equal(created.body.aiConfigured, true);
    assert.equal(created.body.fallback, false);
    assert.equal(created.body.questionCount, 3);
    assert.equal((await request(app).get(`/api/client/${created.body.token}`)).body.questions[0].title, 'Где будут размещены данные?');
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
