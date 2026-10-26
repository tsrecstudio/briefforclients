import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from './index.js';

test('admin creates a private client link; client can save and resume optional answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdis-test-'));
  const { app, db } = createApp({ dbPath: path.join(dir, 'test.sqlite'), uploadDir: path.join(dir, 'uploads'), adminPassword: 'test-secret', sessionSecret: 'test-session-secret' });
  try {
    const unauth = await request(app).get('/api/admin/briefs');
    assert.equal(unauth.status, 401);
    const login = await request(app).post('/api/admin/login').send({ password: 'test-secret' });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const created = await request(app).post('/api/admin/briefs').set('Cookie', cookie).send({ company: 'Тестовая компания', description: 'Производство деталей', request: 'Автоматизировать обработку заявок' });
    assert.equal(created.status, 201);
    assert.equal(created.body.questionCount, 8);
    const token = created.body.token;
    const client = await request(app).get(`/api/client/${token}`);
    assert.equal(client.status, 200);
    assert.equal(client.body.company, 'Тестовая компания');
    const question = client.body.questions[0];
    assert.equal(question.id, 'fallback-1');
    const saved = await request(app).put(`/api/client/${token}/answers/${question.id}`).send({ value: 'Сократить сроки на 50%' });
    assert.equal(saved.status, 200);
    const resumed = await request(app).get(`/api/client/${token}`);
    assert.equal(JSON.parse(resumed.body.answers[0].value), 'Сократить сроки на 50%');
    assert.equal((await request(app).get('/api/client/not-a-valid-token')).status, 404);
    const adminList = await request(app).get('/api/admin/briefs').set('Cookie', cookie);
    assert.equal(adminList.body[0].company, 'Тестовая компания');
    assert.equal(adminList.body[0].answered, 1);
    const rotated = await request(app).post(`/api/admin/briefs/${created.body.id}/link`).set('Cookie', cookie);
    assert.equal(rotated.status, 200);
    assert.equal((await request(app).get(`/api/client/${rotated.body.token}`)).status, 200);
    assert.equal((await request(app).get(`/api/client/${token}`)).status, 200, 'creating another link should not invalidate earlier links');
    const denied = await request(app).get(`/api/files/no-file?token=${token}`);
    assert.equal(denied.status, 404);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('client can mark a brief complete and upload a permitted attachment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdis-files-'));
  const { app, db } = createApp({ dbPath: path.join(dir, 'test.sqlite'), uploadDir: path.join(dir, 'uploads'), adminPassword: 'admin', sessionSecret: 'secret' });
  try {
    const login = await request(app).post('/api/admin/login').send({ password: 'admin' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const created = await request(app).post('/api/admin/briefs').set('Cookie', cookie).send({ company: 'Файлы ООО', description: 'Производство', request: 'Процесс' });
    const token = created.body.token;
    const brief = await request(app).get(`/api/client/${token}`);
    const fileQ = brief.body.questions.find((q:any) => q.type === 'file');
    const uploaded = await request(app).post(`/api/client/${token}/questions/${fileQ.id}/files`).attach('files', Buffer.from('Схема процесса'), { filename: 'process.txt', contentType: 'text/plain' });
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.body.files.length, 1);
    const file = uploaded.body.files[0];
    const download = await request(app).get(`/api/files/${file.id}?token=${token}`);
    assert.equal(download.status, 200);
    assert.equal(download.text, 'Схема процесса');
    const complete = await request(app).post(`/api/client/${token}/status`).send({ status: 'completed' });
    assert.equal(complete.body.status, 'completed');
    assert.equal((await request(app).get(`/api/client/${token}`)).body.status, 'completed');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
