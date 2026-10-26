import crypto from 'node:crypto';

export type QType = 'text' | 'textarea' | 'single' | 'multi' | 'scale' | 'file' | 'yesno';
export interface BriefQuestion { id: string; title: string; help?: string; type: QType; options?: string[]; impact?: string; }
export interface Intake { company: string; contact?: string; email?: string; website?: string; industry?: string; description: string; request: string; known?: string; }

export const makeId = (bytes = 18) => crypto.randomBytes(bytes).toString('hex');
export const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function normalizeQuestions(input: unknown): BriefQuestion[] {
  if (!Array.isArray(input)) throw new Error('AI вернул некорректный список вопросов');
  const supported: QType[] = ['text', 'textarea', 'single', 'multi', 'scale', 'file', 'yesno'];
  const result = input.slice(0, 14).map((raw: any, index) => {
    const type: QType = supported.includes(raw?.type) ? raw.type : 'textarea';
    const title = String(raw?.title ?? '').trim().slice(0, 240);
    if (!title) return null;
    const options = Array.isArray(raw.options) ? raw.options.map((x: unknown) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 8) : undefined;
    return { id: `q${index + 1}-${makeId(3)}`, title, help: String(raw.help ?? '').trim().slice(0, 280) || undefined, type,
      options: ['single', 'multi'].includes(type) ? (options?.length ? options : ['Пока не знаю', 'Другой вариант']) : undefined,
      impact: String(raw.impact ?? '').trim().slice(0, 160) || undefined } as BriefQuestion;
  }).filter(Boolean) as BriefQuestion[];
  if (result.length < 3) throw new Error('Нужно минимум три осмысленных вопроса');
  return result;
}

export const fallbackQuestions: BriefQuestion[] = [
  { id: 'fallback-1', title: 'Какой результат будет для вас признаком успеха?', help: 'Например: сократить время обработки заказа вдвое или исключить ручной ввод.', type: 'textarea', impact: 'Цели и критерии приемки' },
  { id: 'fallback-2', title: 'Какой вариант лучше описывает масштаб решения?', type: 'single', options: ['Один отдел или команда', 'Вся компания', 'Несколько компаний / филиалов', 'Пока не определились'], impact: 'Границы системы и нагрузка' },
  { id: 'fallback-3', title: 'С какими системами решение должно обмениваться данными?', help: 'Названия, версии и направление обмена, если известно.', type: 'textarea', impact: 'Интеграционная архитектура' },
  { id: 'fallback-4', title: 'Где предпочтительно размещать систему?', type: 'single', options: ['В облаке', 'На собственных серверах', 'Гибридно', 'Нужна рекомендация'], impact: 'Инфраструктура и безопасность' },
  { id: 'fallback-5', title: 'Какие устройства и условия работы важно учесть?', help: 'Офис, цех, склад, мобильная работа, отсутствие интернета и т. п.', type: 'multi', options: ['Рабочие компьютеры', 'Телефоны / планшеты', 'Терминалы / сканеры', 'Рабочие места в производстве', 'Работа без интернета'], impact: 'Клиентские приложения и оборудование' },
  { id: 'fallback-6', title: 'Есть ли требования к данным, доступам или регулированию?', type: 'textarea', help: 'Персональные данные, коммерческая тайна, отраслевые нормы, журналирование.', impact: 'Модель безопасности и соответствие' },
  { id: 'fallback-7', title: 'Какой объем пользователей и операций ожидается?', type: 'text', help: 'Можно указать оценочно или написать «пока не знаем».', impact: 'Производительность и масштабирование' },
  { id: 'fallback-8', title: 'Прикрепите материалы, которые помогут понять процессы', type: 'file', help: 'Подойдут схемы, формы, примеры отчетов, скриншоты или технические описания.', impact: 'Исходные данные для проектирования' },
];

export function parseModelQuestions(content: string): unknown {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(clean);
  return Array.isArray(parsed) ? parsed : parsed.questions;
}
