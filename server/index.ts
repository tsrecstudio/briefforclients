import express, { type Request, type Response, type NextFunction } from 'express';
import { DatabaseSync } from 'node:sqlite';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fallbackQuestions, hash, makeId, normalizeQuestions, parseModelQuestions, safeEqual, type Intake } from './core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
type AppOptions = { dbPath?: string; uploadDir?: string; adminPassword?: string; sessionSecret?: string; deepseekApiKey?: string; model?: string; production?: boolean };

function safeJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
export function createApp(options: AppOptions = {}) {
  const app = express();
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? path.join(ROOT, 'data', 'briefs.sqlite');
  const uploadDir = options.uploadDir ?? process.env.UPLOAD_DIR ?? path.join(ROOT, 'data', 'uploads');
  const secret = options.sessionSecret ?? process.env.SESSION_SECRET ?? 'local-development-secret-change-me';
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '';
  const apiKey = options.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
  const model = options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
  const production = options.production ?? process.env.NODE_ENV === 'production';
  if (production && (!adminPassword || !(options.sessionSecret || process.env.SESSION_SECRET))) throw new Error('В production необходимо задать ADMIN_PASSWORD и SESSION_SECRET');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true }); fs.mkdirSync(uploadDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, company TEXT NOT NULL, contact TEXT, email TEXT, website TEXT, industry TEXT,
    description TEXT NOT NULL, request TEXT NOT NULL, known TEXT, questions TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_progress', model TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS answers (brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE, question_id TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY (brief_id, question_id));
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE, question_id TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS brief_tokens (token_hash TEXT PRIMARY KEY, brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE, created_at TEXT NOT NULL);`);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  const sessionToken = (timestamp: number) => `${timestamp}.${crypto.createHmac('sha256', secret).update(String(timestamp)).digest('hex')}`;
  const loginFailures = new Map<string, { count: number; since: number }>();
  const verifySession = (token: string) => {
    const [ts, sig] = token.split('.'); const age = Date.now() - Number(ts);
    return Number.isFinite(Number(ts)) && age >= 0 && age < 12 * 60 * 60 * 1000 && safeEqual(sessionToken(Number(ts)), token);
  };
  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const token = parseCookie(req.headers.cookie || '', 'mcdis_admin');
    if (!token || !verifySession(token)) return res.status(401).json({ error: 'Необходим вход администратора' });
    next();
  }
  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const attempt = loginFailures.get(ip);
    if (attempt && Date.now() - attempt.since < 15 * 60 * 1000 && attempt.count >= 8) return res.status(429).json({ error: 'Слишком много попыток. Повторите через 15 минут.' });
    const supplied = String(req.body?.password ?? '');
    if (!adminPassword) return res.status(503).json({ error: 'Задайте ADMIN_PASSWORD в настройках сервера' });
    if (!safeEqual(hash(supplied), hash(adminPassword))) {
      const current = loginFailures.get(ip);
      loginFailures.set(ip, !current || Date.now() - current.since >= 15 * 60 * 1000 ? { count: 1, since: Date.now() } : { count: current.count + 1, since: current.since });
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    loginFailures.delete(ip);
    const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `mcdis_admin=${sessionToken(Date.now())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', (_req, res) => { res.setHeader('Set-Cookie', 'mcdis_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); res.json({ ok: true }); });
  app.get('/api/admin/me', requireAdmin, (_req, res) => res.json({ ok: true, model }));

  const storage = multer.diskStorage({ destination: uploadDir, filename: (_req, file, cb) => cb(null, `${makeId(20)}${path.extname(file.originalname).slice(0, 12)}`) });
  const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024, files: 5 }, fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/plain|text\/csv|application\/(zip|vnd\.openxmlformats-officedocument\..+|msword|vnd\.ms-excel)|application\/vnd\.ms-excel|application\/octet-stream)$/.test(file.mimetype);
    if (ok) cb(null, true); else cb(new Error('Этот тип файла не поддерживается'));
  } });

  app.post('/api/admin/briefs', requireAdmin, async (req, res) => {
    const body = req.body ?? {};
    const intake: Intake = { company: String(body.company ?? '').trim(), contact: String(body.contact ?? '').trim(), email: String(body.email ?? '').trim(), website: String(body.website ?? '').trim(), industry: String(body.industry ?? '').trim(), description: String(body.description ?? '').trim(), request: String(body.request ?? '').trim(), known: String(body.known ?? '').trim() };
    if (!intake.company || !intake.description || !intake.request) return res.status(400).json({ error: 'Заполните компанию, описание и запрос' });
    if ([intake.company, intake.description, intake.request].some(x => x.length > 8000)) return res.status(400).json({ error: 'Слишком длинное описание (максимум 8000 символов)' });
    let questions = fallbackQuestions; let usedModel = 'Встроенный шаблон';
    if (apiKey) {
      try {
        const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({
          model, stream: false, response_format: { type: 'json_object' }, thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 6000,
          messages: [
            { role: 'system', content: 'Ты — ведущий бизнес-аналитик и архитектор заказной разработки МСДИС. Составь на русском языке персональный клиентский бриф. Верни только JSON object вида {"questions":[...]}. Никаких вводных и заключений. 7–12 вопросов, не более 14. Спрашивай только то, что реально влияет на границы решения, архитектуру, интеграции, инфраструктуру, данные, безопасность, UX/оборудование, нефункциональные требования, миграцию или план запуска. Учитывай сведения из запроса, не спрашивай повторно то, что уже известно. Вопрос должен быть одним конкретным и дружелюбным, без жаргона, без обязательности и без вопросов о бюджете/сроках/контактах/маркетинговых целях. Тип выбирай один из: text, textarea, single, multi, scale, file, yesno. Для single/multi добавляй 3–6 коротких options с реальными альтернативами, включая «Пока не знаем» когда уместно. Для scale пиши options из 1..5. Для остальных типов options не нужны. У каждого вопроса поля title, help (короткое пояснение), type, options, impact (архитектурное решение, на которое ответ влияет). Вопросы должны быть естественными и не дублировать друг друга. Не делай вопрос обязательным.' },
            { role: 'user', content: JSON.stringify(intake) }
          ]
        }) });
        if (!response.ok) throw new Error(`DeepSeek API: ${response.status}`);
        const data: any = await response.json();
        questions = normalizeQuestions(parseModelQuestions(data.choices?.[0]?.message?.content ?? ''));
        usedModel = model;
      } catch (error) { console.error('DeepSeek generation failed; using fallback:', error); }
    }
    const id = makeId(12); const token = makeId(32); const now = new Date().toISOString();
    db.prepare('INSERT INTO briefs (id, token_hash, company, contact, email, website, industry, description, request, known, questions, created_at, updated_at, model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, hash(token), intake.company, intake.contact || null, intake.email || null, intake.website || null, intake.industry || null, intake.description, intake.request, intake.known || null, JSON.stringify(questions), now, now, usedModel);
    res.status(201).json({ id, token, url: `/b/${token}`, model: usedModel, questionCount: questions.length, aiConfigured: Boolean(apiKey), fallback: Boolean(apiKey && usedModel === 'Встроенный шаблон') });
  });
  app.get('/api/admin/briefs', requireAdmin, (_req, res) => {
    const rows = db.prepare(`SELECT b.id,b.company,b.contact,b.email,b.industry,b.created_at,b.updated_at,b.status,b.model,
      (SELECT COUNT(*) FROM answers a WHERE a.brief_id=b.id AND a.value!='') AS answered,
      (SELECT COUNT(*) FROM json_each(b.questions)) AS total,
      (SELECT COUNT(*) FROM files f WHERE f.brief_id=b.id) AS file_count FROM briefs b ORDER BY b.updated_at DESC`).all();
    res.json(rows);
  });
  app.post('/api/admin/briefs/:id/link', requireAdmin, (req, res) => {
    const brief: any = db.prepare('SELECT id FROM briefs WHERE id=?').get(String(req.params.id));
    if (!brief) return res.status(404).json({ error: 'Бриф не найден' });
    const token = makeId(32);
    db.prepare('INSERT INTO brief_tokens (token_hash,brief_id,created_at) VALUES (?,?,?)').run(hash(token), brief.id, new Date().toISOString());
    res.json({ token, url: `/b/${token}` });
  });
  app.get('/api/admin/briefs/:id', requireAdmin, (req, res) => {
    const brief: any = db.prepare('SELECT * FROM briefs WHERE id=?').get(String(req.params.id));
    if (!brief) return res.status(404).json({ error: 'Бриф не найден' });
    const answers = db.prepare('SELECT question_id,value,updated_at FROM answers WHERE brief_id=?').all(brief.id);
    const files = db.prepare('SELECT id,question_id,original_name,mime,size,created_at FROM files WHERE brief_id=? ORDER BY created_at').all(brief.id);
    res.json({ ...brief, token_hash: undefined, questions: safeJson(brief.questions, []), answers, files });
  });
  app.delete('/api/admin/briefs/:id', requireAdmin, (req, res) => {
    const files: any[] = db.prepare('SELECT stored_name FROM files WHERE brief_id=?').all(String(req.params.id));
    const result = db.prepare('DELETE FROM briefs WHERE id=?').run(String(req.params.id));
    files.forEach(f => { try { fs.unlinkSync(path.join(uploadDir, f.stored_name)); } catch {} });
    result.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Бриф не найден' });
  });

  function getClientBrief(token: string) { return db.prepare('SELECT * FROM briefs WHERE token_hash=? UNION ALL SELECT b.* FROM briefs b JOIN brief_tokens t ON t.brief_id=b.id WHERE t.token_hash=? LIMIT 1').get(hash(token), hash(token)) as any; }
  app.get('/api/client/:token', (req, res) => {
    const brief = getClientBrief(req.params.token);
    if (!brief) return res.status(404).json({ error: 'Ссылка не найдена или больше не действует' });
    const answers = db.prepare('SELECT question_id,value,updated_at FROM answers WHERE brief_id=?').all(brief.id);
    const files = db.prepare('SELECT id,question_id,original_name,mime,size,created_at FROM files WHERE brief_id=? ORDER BY created_at').all(brief.id);
    res.json({ id: brief.id, company: brief.company, questions: safeJson(brief.questions, []), answers, files, status: brief.status, updated_at: brief.updated_at });
  });
  const saveAnswer = (req: Request, res: Response) => {
    const brief = getClientBrief(String(req.params.token));
    if (!brief) return res.status(404).json({ error: 'Ссылка не найдена или больше не действует' });
    const question = safeJson<any[]>(brief.questions, []).find(q => q.id === req.params.questionId);
    if (!question) return res.status(404).json({ error: 'Вопрос не найден' });
    const value = JSON.stringify(req.body?.value ?? '');
    if (value.length > 20000) return res.status(400).json({ error: 'Ответ слишком длинный' });
    const now = new Date().toISOString();
    db.prepare('INSERT INTO answers (brief_id, question_id, value, updated_at) VALUES (?,?,?,?) ON CONFLICT(brief_id,question_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(brief.id, question.id, value, now);
    db.prepare('UPDATE briefs SET updated_at=? WHERE id=?').run(now, brief.id);
    res.json({ ok: true, savedAt: now });
  };
  app.put('/api/client/:token/answers/:questionId', saveAnswer);
  app.post('/api/client/:token/answers/:questionId', saveAnswer);
  app.post('/api/client/:token/status', (req, res) => {
    const brief = getClientBrief(req.params.token);
    if (!brief) return res.status(404).json({ error: 'Ссылка не найдена или больше не действует' });
    const status = req.body?.status === 'completed' ? 'completed' : 'in_progress'; const now = new Date().toISOString();
    db.prepare('UPDATE briefs SET status=?,updated_at=? WHERE id=?').run(status, now, brief.id);
    res.json({ ok: true, status });
  });
  app.post('/api/client/:token/questions/:questionId/files', (req, res, next) => {
    const brief = getClientBrief(req.params.token);
    if (!brief) return res.status(404).json({ error: 'Ссылка не найдена или больше не действует' });
    const question = safeJson<any[]>(brief.questions, []).find(q => q.id === req.params.questionId);
    if (!question || question.type !== 'file') return res.status(400).json({ error: 'Загрузка не предусмотрена для этого вопроса' });
    upload.array('files', 5)(req, res, (err: any) => {
      if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файлы' });
      const files = (req.files as Express.Multer.File[] || []);
      const insert = db.prepare('INSERT INTO files (id,brief_id,question_id,original_name,stored_name,mime,size,created_at) VALUES (?,?,?,?,?,?,?,?)');
      const now = new Date().toISOString();
      files.forEach(f => insert.run(makeId(12), brief.id, question.id, path.basename(f.originalname).slice(0, 240), f.filename, f.mimetype, f.size, now));
      db.prepare('UPDATE briefs SET updated_at=? WHERE id=?').run(now, brief.id);
      res.json({ files: db.prepare('SELECT id,question_id,original_name,mime,size,created_at FROM files WHERE brief_id=? AND question_id=? ORDER BY created_at').all(brief.id, question.id) });
    });
  });
  app.get('/api/files/:id', (req, res) => {
    const file: any = db.prepare('SELECT f.*,b.token_hash FROM files f JOIN briefs b ON b.id=f.brief_id WHERE f.id=?').get(req.params.id);
    if (!file) return res.status(404).end();
    const token = req.query.token ? String(req.query.token) : '';
    const admin = parseCookie(req.headers.cookie || '', 'mcdis_admin');
    if (!safeEqual(hash(token), file.token_hash) && !(admin && verifySession(admin))) return res.status(403).json({ error: 'Нет доступа к файлу' });
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.type(file.mime); res.sendFile(path.resolve(uploadDir, file.stored_name));
  });

  app.use('/uploads', (_req, res) => res.status(404).end());
  app.use(express.static(path.join(ROOT, 'dist')));
  app.get('*path', (_req, res, next) => {
    const index = path.join(ROOT, 'dist', 'index.html');
    if (fs.existsSync(index)) res.sendFile(index); else next();
  });
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err); if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  });
  return { app, db };
}
function parseCookie(header: string, name: string) { const item = header.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`)); return item?.slice(name.length + 1) ?? ''; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createApp(); const port = Number(process.env.PORT ?? 4000);
  app.listen(port, '0.0.0.0', () => console.log(`MCDis client brief listening on 0.0.0.0:${port}`));
}
