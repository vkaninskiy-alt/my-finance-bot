"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const https = require("https");
const Tesseract = require("tesseract.js");
const { parseAmount, quickExpenseParts } = require("./expense-utils");
const sqlite3 = require("sqlite3").verbose();
const { Telegraf, Markup } = require("telegraf");
const cfg = require("./config");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Ошибка: в .env отсутствует BOT_TOKEN");
  process.exit(1);
}

const bot = new Telegraf(token);
const db = new sqlite3.Database(path.join(__dirname, "expenses.db"));
const userSteps = new Map();

const MAX_AMOUNT = 1_000_000_000;
const MAX_COMMENT_LENGTH = 1000;
const MAX_GROUP_MEMBERS = 10;
const GROUP_CODE_TTL = 15 * 60 * 1000;
const APP_TIMEZONE = process.env.APP_TIMEZONE || "UTC";

let shuttingDown = false;
let server;

function md(extra = {}) {
  return { parse_mode: "Markdown", ...extra };
}

function escapeMd(value) {
  return String(value ?? "").replace(/([_*`[\]\\])/g, "\\$1");
}

function formatAmount(value) {
  return `${Number(value || 0).toLocaleString("ru-RU", {
    maximumFractionDigits: 2
  })} ₽`;
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// Serialize transactions so another update handled by this process cannot run
// statements in the middle of a multi-step database operation.
let transactionQueue = Promise.resolve();
function withTransaction(work) {
  const run = transactionQueue.then(async () => {
    await dbRun("BEGIN IMMEDIATE");
    try {
      const result = await work();
      await dbRun("COMMIT");
      return result;
    } catch (error) {
      try { await dbRun("ROLLBACK"); } catch (rollbackError) {
        console.error("Ошибка отката транзакции:", rollbackError);
      }
      throw error;
    }
  });
  transactionQueue = run.catch(() => {});
  return run;
}

function dateInTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function periodStart(period) {
  const today = dateInTimezone();
  if (period === "today") return today;
  if (period === "week") return addDays(today, -6);
  return `${today.slice(0, 7)}-01`;
}

async function initDb() {
  await dbRun(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    category TEXT,
    comment TEXT,
    user_name TEXT,
    date TEXT
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    monthly_limit REAL,
    group_code TEXT,
    group_code_created_at TEXT,
    group_id TEXT
  )`);

  const columns = await dbAll("PRAGMA table_info(settings)");
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("group_code_created_at")) {
    await dbRun("ALTER TABLE settings ADD COLUMN group_code_created_at TEXT");
  }
  if (!columnNames.has("group_id")) {
    await dbRun("ALTER TABLE settings ADD COLUMN group_id TEXT");
  }
  if (!columnNames.has("first_name")) {
    await dbRun("ALTER TABLE settings ADD COLUMN first_name TEXT");
  }
  if (!columnNames.has("username")) {
    await dbRun("ALTER TABLE settings ADD COLUMN username TEXT");
  }
  if (!columnNames.has("personal_limit")) {
    await dbRun("ALTER TABLE settings ADD COLUMN personal_limit REAL");
  }
  if (!columnNames.has("family_limit")) {
    await dbRun("ALTER TABLE settings ADD COLUMN family_limit REAL");
  }
  // Existing monthly_limit values become both personal and family limits for compatibility.
  await dbRun("UPDATE settings SET personal_limit = COALESCE(personal_limit, monthly_limit), family_limit = COALESCE(family_limit, monthly_limit)");

  await dbRun(`CREATE TABLE IF NOT EXISTS family_groups (
    group_id TEXT PRIMARY KEY,
    invite_code TEXT UNIQUE,
    invite_created_at TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`);

  // Migrate existing groups without losing memberships or their current invite codes.
  const legacyGroups = await dbAll(`SELECT group_code, MIN(user_id) AS fallback_creator_id,
    MIN(group_code_created_at) AS created_at FROM settings
    WHERE group_code IS NOT NULL AND group_code != '' GROUP BY group_code`);
  for (const group of legacyGroups) {
    await dbRun("UPDATE settings SET group_id = group_code WHERE group_code = ? AND (group_id IS NULL OR group_id = '')", [group.group_code]);
    const creator = await dbGet("SELECT user_id FROM settings WHERE group_code = ? AND group_code_created_at IS NOT NULL ORDER BY user_id LIMIT 1", [group.group_code]);
    const creatorId = creator?.user_id ?? group.fallback_creator_id;
    // Preserve the original invite timestamp so migration does not extend an expired code.
    const createdAt = group.created_at || new Date(0).toISOString();
    await dbRun(`INSERT OR IGNORE INTO family_groups
      (group_id, invite_code, invite_created_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)`, [group.group_code, group.group_code, createdAt, creatorId, createdAt]);
  }

  const expenseColumns = await dbAll("PRAGMA table_info(expenses)");
  if (!expenseColumns.some((column) => column.name === "receipt_file_unique_id")) {
    await dbRun("ALTER TABLE expenses ADD COLUMN receipt_file_unique_id TEXT");
  }
  if (!expenseColumns.some((column) => column.name === "budget_type")) {
    await dbRun("ALTER TABLE expenses ADD COLUMN budget_type TEXT NOT NULL DEFAULT 'personal'");
    // Preserve the historical meaning of expenses entered while users were in a family group.
    await dbRun(`UPDATE expenses SET budget_type = 'family'
      WHERE user_id IN (SELECT user_id FROM settings WHERE COALESCE(group_id, group_code) IS NOT NULL)`);
  }
  await dbRun("CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_settings_group_id ON settings(group_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_settings_group_code ON settings(group_code)");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_family_invite_code ON family_groups(invite_code) WHERE invite_code IS NOT NULL");
}

async function getUserGroup(userId) {
  const row = await dbGet("SELECT group_id, group_code FROM settings WHERE user_id = ?", [userId]);
  return row?.group_id || row?.group_code || null;
}

async function getGroupIds(userId) {
  const groupId = await getUserGroup(userId);
  if (!groupId) return [userId];
  const members = await dbAll("SELECT user_id FROM settings WHERE COALESCE(group_id, group_code) = ?", [groupId]);
  const ids = members.map((member) => Number(member.user_id));
  return ids.length ? ids : [userId];
}

async function getUserLimit(userId, budgetType = "personal") {
  const groupId = await getUserGroup(userId);
  const column = budgetType === "family" ? "family_limit" : "personal_limit";
  const row = budgetType === "family" && groupId
    ? await dbGet(`SELECT ${column} AS budget_limit FROM settings WHERE COALESCE(group_id, group_code) = ? ORDER BY user_id ASC LIMIT 1`, [groupId])
    : await dbGet(`SELECT ${column} AS budget_limit FROM settings WHERE user_id = ?`, [userId]);
  const limit = Number(row?.budget_limit);
  return Number.isFinite(limit) && limit > 0 ? limit : cfg.DEFAULT_LIMIT;
}

async function setUserLimit(userId, amount, budgetType = "personal") {
  const column = budgetType === "family" ? "family_limit" : "personal_limit";
  await withTransaction(async () => {
    const groupId = await getUserGroup(userId);
    await dbRun(`INSERT INTO settings (user_id, monthly_limit, ${column}, group_id)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET ${column} = excluded.${column}`,
      [userId, amount, amount, groupId]);
    if (budgetType === "family" && groupId) {
      await dbRun(`UPDATE settings SET family_limit = ?, monthly_limit = ? WHERE COALESCE(group_id, group_code) = ?`,
        [amount, amount, groupId]);
    } else {
      await dbRun("UPDATE settings SET monthly_limit = ? WHERE user_id = ?", [amount, userId]);
    }
  });
}

async function sendSettingsMessage(ctx, userId) {
  const groupId = await getUserGroup(userId);
  const personalLimit = await getUserLimit(userId, "personal");
  const familyLimit = groupId ? await getUserLimit(userId, "family") : null;
  const status = groupId ? "👥 Семейная группа подключена" : "👤 Личный аккаунт";
  const rows = [
    [Markup.button.callback("💰 Лимит личного бюджета", "edit_personal_limit")],
  ];
  if (groupId) {
    rows.push([Markup.button.callback("👨‍👩‍👧 Лимит семейного бюджета", "edit_family_limit")]);
    rows.push([Markup.button.callback("👥 Семейный доступ", "family_menu")]);
  } else {
    rows.push([Markup.button.callback("👥 Семейный доступ", "family_menu")]);
  }
  const message = `⚙️ *Настройки бюджета*\n\n${status}\n\n👤 Личный лимит: *${formatAmount(personalLimit)}*` +
    (groupId ? `\n👨‍👩‍👧 Семейный лимит: *${formatAmount(familyLimit)}*` : "\n\nПодключи семейную группу, чтобы настроить отдельный общий лимит.") +
    "\n\nВыбери, какой лимит изменить:";
  const keyboard = Markup.inlineKeyboard(rows);
  if (ctx.callbackQuery) return ctx.editMessageText(message, md(keyboard));
  return ctx.reply(message, md(keyboard));
}

const PERIODS = {
  today: { label: "Сегодня" },
  week: { label: "Последние 7 дней" },
  month: { label: "Текущий месяц" }
};

function statsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📅 Сегодня", "stats_today"), Markup.button.callback("🗓 7 дней", "stats_week")],
    [Markup.button.callback("📆 Этот месяц", "stats_month")]
  ]);
}

function budgetMeter(spent, limit) {
  const safeLimit = Number(limit) > 0 ? Number(limit) : cfg.DEFAULT_LIMIT;
  const ratio = Number(spent || 0) / safeLimit;
  const percent = Math.round(ratio * 100);
  const filled = Math.min(10, Math.max(0, Math.round(ratio * 10)));
  const block = ratio >= 1 ? "🟥" : "🟩";
  const bar = block.repeat(filled) + "▫️".repeat(10 - filled);
  const remaining = safeLimit - Number(spent || 0);
  const remainderText = remaining >= 0
    ? `Остаток: *${formatAmount(remaining)}*`
    : `⚠️ Превышение: *${formatAmount(Math.abs(remaining))}*`;
  return `Лимит: *${formatAmount(safeLimit)}*\n${bar} *${percent}%*\n${remainderText}`;
}

async function sendStats(ctx, period = "month", edit = false) {
  const selected = PERIODS[period] ? period : "month";
  const userId = ctx.from.id;
  const groupId = await getUserGroup(userId);
  const ids = await getGroupIds(userId);
  const placeholders = ids.map(() => "?").join(", ");
  const start = periodStart(selected);
  const today = dateInTimezone();
  const monthStart = `${today.slice(0, 7)}-01`;

  async function getBreakdown(type, dateStart) {
    const userClause = type === "personal" ? "user_id = ?" : `user_id IN (${placeholders})`;
    const ownerParams = type === "personal" ? [userId] : ids;
    const rows = await dbAll(
      `SELECT category, SUM(amount) AS total
       FROM expenses
       WHERE ${userClause} AND budget_type = ? AND date >= ? AND date <= ?
       GROUP BY category ORDER BY total DESC`,
      [...ownerParams, type, dateStart, today]
    );
    return {
      total: rows.reduce((sum, row) => sum + Number(row.total || 0), 0),
      lines: rows.length
        ? rows.map((row) => `• ${escapeMd(row.category)} — *${formatAmount(row.total)}*`).join("\n")
        : "🌱 Пока нет расходов за этот период."
    };
  }

  const personal = await getBreakdown("personal", start);
  const personalMonth = await getBreakdown("personal", monthStart);
  const personalLimit = await getUserLimit(userId, "personal");
  let family = null;
  let familyMonth = null;
  let familyLimit = null;
  if (groupId) {
    family = await getBreakdown("family", start);
    familyMonth = await getBreakdown("family", monthStart);
    familyLimit = await getUserLimit(userId, "family");
  }

  let message = `📊 *Твой бюджет*\n📆 ${escapeMd(PERIODS[selected].label)}\n${cfg.DIVIDER}\n\n` +
    `👤 *ЛИЧНЫЙ БЮДЖЕТ*\n${personal.lines}\n\n` +
    `💸 Потрачено за период: *${formatAmount(personal.total)}*\n` +
    `📈 *Лимит за текущий месяц*\n${budgetMeter(personalMonth.total, personalLimit)}`;

  if (groupId && family && familyMonth) {
    message += `\n\n${cfg.DIVIDER}\n\n👨‍👩‍👧 *СЕМЕЙНЫЙ БЮДЖЕТ*\n${family.lines}\n\n` +
      `💸 Потрачено за период: *${formatAmount(family.total)}*\n` +
      `📈 *Лимит за текущий месяц*\n${budgetMeter(familyMonth.total, familyLimit)}`;
  } else {
    message += `\n\n${cfg.DIVIDER}\n\n👨‍👩‍👧 *СЕМЕЙНЫЙ БЮДЖЕТ*\n` +
      `Подключи участников в разделе «👥 Семья», чтобы вести общий бюджет и лимит.`;
  }

  if (edit && ctx.callbackQuery) return ctx.editMessageText(message, md(statsKeyboard()));
  return ctx.reply(message, md(statsKeyboard()));
}

function quickExpense(text) {
  return quickExpenseParts(text, cfg.CATEGORIES);
}

async function downloadTelegramFile(url, destination) {
  await new Promise((resolve, reject) => {
    const file = require("fs").createWriteStream(destination);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        file.close(() => {});
        return reject(new Error(`Telegram file download failed: ${response.statusCode}`));
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (error) => { file.close(() => {}); reject(error); });
  });
}

function parseReceiptFields(rawText) {
  const raw = String(rawText || '').replace(/\r/g, '\n');
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const totalKeywords = /итого|к\s*оплате|всего|total|amount\s*due|summa|kokku|tasuda/i;
  const moneyPattern = /(?:€|EUR\s*)?\s*(\d{1,7}(?:[ .]\d{3})*[,.]\d{2})\s*(?:€|EUR)?/i;
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(moneyPattern);
    if (!match) continue;
    const amount = parseAmount(match[1].replace(/[ .](?=\d{3}(?:[,.]|$))/g, '').replace(/\s/g, ''));
    if (amount === null) continue;
    const keyword = totalKeywords.test(line);
    // Give priority to explicitly labelled total lines; avoid blindly choosing the largest item.
    candidates.push({ amount, score: keyword ? 10 : (/summa|kokku|total/i.test(line) ? 8 : 1), index: i });
  }
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  const amount = candidates[0]?.amount ?? null;
  const dateMatch = raw.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/);
  let date = null;
  if (dateMatch) {
    const year = dateMatch[3].length === 2 ? `20${dateMatch[3]}` : dateMatch[3];
    date = `${year}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) date = null;
  }
  const merchant = lines.find((line) => /[a-zа-яёõäöü]{3}/i.test(line) && !totalKeywords.test(line) && !/\d{2}[./-]\d{2}[./-]\d{2,4}/.test(line) && line.length <= 70) || null;
  return { amount, date, merchant, raw: raw.slice(0, 1000) };
}

async function handleReceiptPhoto(ctx) {
  const userId = ctx.from.id;
  const state = userSteps.get(userId);
  if (!state || state.step !== 'awaiting_receipt_photo') {
    return ctx.reply('Чтобы распознать чек, нажми «➕ Добавить расход» → «🧾 Распознать чек».', md(cfg.menuKeyboard));
  }
  const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
  if (!photo) return ctx.reply('Пришли фотографию чека как изображение.');
  if (photo.file_size && photo.file_size > 10 * 1024 * 1024) {
    return ctx.reply('Фото слишком большое. Отправь более сжатое изображение.');
  }
  const receiptFileUniqueId = photo.file_unique_id || null;
  if (receiptFileUniqueId) {
    const duplicate = await dbGet('SELECT id, date FROM expenses WHERE receipt_file_unique_id = ? LIMIT 1', [receiptFileUniqueId]);
    if (duplicate) {
      return ctx.reply(`⚠️ Похоже, этот чек уже добавлен (${escapeMd(duplicate.date)}). Чтобы не задвоить расход, я не буду записывать его повторно.`, md(cfg.menuKeyboard));
    }
  }
  await ctx.reply('🧾 Распознаю чек. Это может занять до минуты…');
  const tempPath = path.join(os.tmpdir(), `receipt-${userId}-${Date.now()}.jpg`);
  try {
    const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
    await downloadTelegramFile(fileUrl.href || String(fileUrl), tempPath);
    const result = await Tesseract.recognize(tempPath, 'eng+rus+est');
    const parsed = parseReceiptFields(result.data.text);
    if (parsed.amount === null) {
      userSteps.set(userId, { step: 'awaiting_amount', receiptText: parsed.raw, receiptMerchant: parsed.merchant, receiptDate: parsed.date });
      return ctx.reply('Не удалось надёжно определить итоговую сумму. Можешь ввести её вручную — распознанный чек не будет сохранён без подтверждения.', md(Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Ввести сумму вручную', 'receipt_manual_amount')],
        [Markup.button.callback('🔄 Попробовать ещё раз', 'receipt_retry')],
        [Markup.button.callback('❌ Отмена', 'cancel_action')]
      ])));
    }
    userSteps.set(userId, { step: 'awaiting_receipt_review', amount: parsed.amount, receiptText: parsed.raw, receiptMerchant: parsed.merchant, receiptDate: parsed.date, receiptFileUniqueId });
    const summary = `🧾 *Проверь данные чека*\n\n` +
      `💰 Сумма: *${formatAmount(parsed.amount)}*\n` +
      `🏪 Магазин: ${escapeMd(parsed.merchant || 'не распознан')}\n` +
      `📅 Дата: ${escapeMd(parsed.date || 'не распознана')}\n\n` +
      `Проверь сумму: OCR может ошибаться. Расход будет сохранён только после подтверждения.`;
    return ctx.reply(summary, md(Markup.inlineKeyboard([
      [Markup.button.callback('✅ Всё верно, продолжить', 'receipt_confirm')],
      [Markup.button.callback('✏️ Исправить сумму', 'receipt_edit_amount')],
      [Markup.button.callback('🔄 Другой чек', 'receipt_retry')],
      [Markup.button.callback('❌ Отмена', 'cancel_action')]
    ])));
  } catch (error) {
    console.error('Ошибка распознавания чека:', error.message);
    return ctx.reply('Не удалось обработать чек. Попробуй другое фото или введи сумму вручную.', md(Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Ввести сумму вручную', 'receipt_manual_amount')],
      [Markup.button.callback('🔄 Попробовать ещё раз', 'receipt_retry')],
      [Markup.button.callback('❌ Отмена', 'cancel_action')]
    ])));
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function finishExpense(ctx, comment) {
  const userId = ctx.from.id;
  const state = userSteps.get(userId);
  if (!state || state.step !== "awaiting_comment") {
    return ctx.reply("↩️ Начни добавление расхода заново.", md(cfg.menuKeyboard));
  }
  if (!Number.isFinite(state.amount) || state.amount <= 0 || state.amount > MAX_AMOUNT || !state.category) {
    userSteps.delete(userId);
    return ctx.reply("⚠️ Данные расхода некорректны. Попробуй ещё раз.", md(cfg.menuKeyboard));
  }
  const cleanComment = String(comment ?? "").trim().slice(0, MAX_COMMENT_LENGTH) || "Без комментария";
  await dbRun(`INSERT INTO expenses (user_id, amount, category, comment, user_name, date, budget_type, receipt_file_unique_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [userId, state.amount, state.category, cleanComment,
    String(ctx.from.first_name || "Пользователь").slice(0, 100), dateInTimezone(), state.budgetType === "family" ? "family" : "personal", state.receiptFileUniqueId || null]);
  const groupId = await getUserGroup(userId);
  userSteps.delete(userId);
  return ctx.reply(groupId
    ? "✅ *Расход записан в общий семейный бюджет!*"
    : "✅ *Расход успешно записан в ваш личный бюджет!*", md(cfg.menuKeyboard));
}

async function createFamilyGroup(ctx) {
  const userId = ctx.from.id;
  if (await getUserGroup(userId)) {
    return ctx.editMessageText("Ты уже состоишь в семейной группе.", md(cfg.familyInline));
  }
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const suffix = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join("");
  const inviteCode = `FAM-${suffix}`;
  const createdAt = new Date().toISOString();
  const groupId = crypto.randomUUID();
  const limit = await getUserLimit(userId);
  await withTransaction(async () => {
    if (await getUserGroup(userId)) throw new Error("Пользователь уже состоит в группе");
    await dbRun("INSERT INTO family_groups (group_id, invite_code, invite_created_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      [groupId, inviteCode, createdAt, userId, createdAt]);
    await dbRun(`INSERT INTO settings (user_id, monthly_limit, group_id, first_name, username)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      monthly_limit = excluded.monthly_limit, group_id = excluded.group_id,
      first_name = excluded.first_name, username = excluded.username`,
      [userId, limit, groupId, ctx.from.first_name || "Участник", ctx.from.username || null]);
  });
  return ctx.editMessageText(`🎉 *Семейная группа создана!*\n\n🔑 Код приглашения: \`${inviteCode}\`\n\n⏰ Код действует 15 минут. Передай его партнёру.`, md(cfg.familyInline));
}

async function joinFamilyGroup(ctx, rawCode) {
  const userId = ctx.from.id;
  const code = String(rawCode || "").trim().toUpperCase();
  if (!/^FAM-[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    return ctx.reply("⚠️ Неверный формат кода. Пример: FAM-ABC234.", md(cfg.cancelInline));
  }
  try {
    const outcome = await withTransaction(async () => {
      const invite = await dbGet("SELECT * FROM family_groups WHERE invite_code = ?", [code]);
      if (!invite) return { error: "INVITE_NOT_FOUND" };
      const createdAt = Date.parse(invite.invite_created_at);
      const elapsed = Date.now() - createdAt;
      if (!Number.isFinite(createdAt) || elapsed < 0 || elapsed > GROUP_CODE_TTL) {
        await dbRun("UPDATE family_groups SET invite_code = NULL, invite_created_at = NULL WHERE group_id = ?", [invite.group_id]);
        return { error: "INVITE_EXPIRED" };
      }
      const existingGroup = await getUserGroup(userId);
      if (existingGroup === invite.group_id) return { error: "ALREADY_MEMBER" };
      if (existingGroup) return { error: "OTHER_GROUP" };
      const members = await dbAll("SELECT user_id FROM settings WHERE group_id = ? OR group_code = ?", [invite.group_id, invite.group_id]);
      if (members.some((member) => Number(member.user_id) === userId)) return { error: "ALREADY_MEMBER" };
      if (members.length >= MAX_GROUP_MEMBERS) return { error: "GROUP_FULL" };
      const creator = await dbGet("SELECT monthly_limit FROM settings WHERE user_id = ?", [invite.created_by]);
      const limit = Number(creator?.monthly_limit) > 0 ? Number(creator.monthly_limit) : cfg.DEFAULT_LIMIT;
      await dbRun(`INSERT INTO settings (user_id, monthly_limit, group_id, first_name, username)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
        monthly_limit = excluded.monthly_limit, group_id = excluded.group_id,
        first_name = excluded.first_name, username = excluded.username`,
        [userId, limit, invite.group_id, ctx.from.first_name || "Участник", ctx.from.username || null]);
      await dbRun("UPDATE settings SET monthly_limit = ? WHERE group_id = ? OR group_code = ?", [limit, invite.group_id, invite.group_id]);
      // Invites are single-use; the family group remains active through group_id.
      await dbRun("UPDATE family_groups SET invite_code = NULL, invite_created_at = NULL WHERE group_id = ?", [invite.group_id]);
      return { success: true };
    });
    if (outcome.error) throw new Error(outcome.error);
  } catch (error) {
    const messages = {
      INVITE_NOT_FOUND: "❌ Код не найден или уже использован. Попроси партнёра создать новый.",
      INVITE_EXPIRED: "⚠️ Код истёк. Попроси партнёра создать новый.",
      ALREADY_MEMBER: "ℹ️ Ты уже состоишь в этой группе.",
      OTHER_GROUP: "⚠️ Сначала выйди из текущей группы.",
      GROUP_FULL: "⚠️ Группа уже заполнена."
    };
    if (messages[error.message]) return ctx.reply(messages[error.message], md(cfg.menuKeyboard));
    throw error;
  }
  userSteps.delete(userId);
  return ctx.reply("🎉 *Ты подключился к семейной группе!*", md(cfg.menuKeyboard));
}

async function leaveFamilyGroup(ctx) {
  const userId = ctx.from.id;
  const groupId = await getUserGroup(userId);
  if (!groupId) return ctx.editMessageText("Ты не состоишь в семейной группе.", md(cfg.familyInline));
  await withTransaction(async () => {
    await dbRun("UPDATE settings SET group_id = NULL, group_code = NULL, group_code_created_at = NULL WHERE user_id = ?", [userId]);
    const members = await dbAll("SELECT user_id FROM settings WHERE group_id = ? OR group_code = ?", [groupId, groupId]);
    if (members.length === 1) {
      await dbRun("UPDATE family_groups SET invite_code = NULL, invite_created_at = NULL WHERE group_id = ?", [groupId]);
    }
  });
  userSteps.delete(userId);
  return ctx.editMessageText("Ты вышел из семейной группы. История расходов сохранена у авторов записей.", md(cfg.familyInline));
}

bot.start(async (ctx) => {
  userSteps.delete(ctx.from.id);
  return ctx.reply(cfg.START_TEXT, md(cfg.menuKeyboard));
});

bot.on("photo", async (ctx) => handleReceiptPhoto(ctx));

bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const state = userSteps.get(userId);

  // Quick format: "12,50 продукты хлеб" or "3.50 кофе".
  if (!state && ![
    "➕ Добавить расход", "📊 Статистика", "📜 История", "📜 История и удаление",
    "👥 Семья", "⚙️ Настройки"
  ].includes(text)) {
    const quick = quickExpense(text);
    if (quick) {
      userSteps.set(userId, { step: "awaiting_category", amount: quick.amount, category: quick.category.label, quickDescription: quick.description });
      const groupId = await getUserGroup(userId);
      if (groupId) {
        userSteps.get(userId).step = "awaiting_budget_type";
        return ctx.reply(`⚡ Распознал: ${formatAmount(quick.amount)}, ${quick.category.label}, «${quick.description}». Куда записать?`, md(Markup.inlineKeyboard([
          [Markup.button.callback("👤 Личный бюджет", "budget_personal")],
          [Markup.button.callback("👥 Семейный бюджет", "budget_family")],
          [Markup.button.callback("❌ Отмена", "cancel_action")]
        ])));
      }
      userSteps.get(userId).budgetType = "personal";
      userSteps.get(userId).step = "awaiting_comment";
      return finishExpense(ctx, quick.description);
    }
  }

  if (text === "➕ Добавить расход") {
    userSteps.set(userId, { step: "choosing_expense_input" });
    return ctx.reply("➕ *Добавить расход*\n\nКак удобнее внести покупку?\n\n⌨️ *Вручную* — если знаешь сумму.\n🧾 *По чеку* — я попробую распознать сумму с фотографии.", md(Markup.inlineKeyboard([
      [Markup.button.callback("⌨️ Ввести сумму", "expense_manual_amount")],
      [Markup.button.callback("🧾 Сканировать чек", "expense_scan_receipt")],
      [Markup.button.callback("✖️ Отмена", "cancel_action")]
    ])));
  }
  if (text === "⚙️ Настройки") {
    userSteps.delete(userId);
    return sendSettingsMessage(ctx, userId);
  }
  if (text === "👥 Семья") {
    userSteps.delete(userId);
    const groupId = await getUserGroup(userId);
    if (groupId) return sendFamilyMembers(ctx, false);
    return ctx.reply(
      "👥 *Семейный бюджет*\n\nСоздай семейную группу и пригласи участников или подключись по коду.",
      md(cfg.familyInline)
    );
  }
  if (text === "📊 Статистика") {
    userSteps.delete(userId);
    return ctx.reply("📊 *Выберите период статистики:*", md(statsKeyboard()));
  }
  if (text === "📜 История" || text === "📜 История и удаление") {
    userSteps.delete(userId);
    const ids = await getGroupIds(userId);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await dbAll(`SELECT id, user_id, amount, category, comment, user_name, date, budget_type
      FROM expenses WHERE user_id IN (${placeholders}) AND (budget_type = 'family' OR (budget_type = 'personal' AND user_id = ?)) ORDER BY id DESC LIMIT 5`, [...ids, userId]);
    if (!rows.length) return ctx.reply("🌱 История трат пуста.", md(cfg.menuKeyboard));
    await ctx.reply("📋 *Последние 5 расходов:*", md());
    for (const row of rows) {
      const message = `🧾 *${escapeMd(row.category)}*\nСумма: *${formatAmount(row.amount)}*\n` +
        `📅 Дата: ${escapeMd(row.date)}\n🏷 Бюджет: ${row.budget_type === "family" ? "Семейный" : "Личный"}\n✍️ Кто: ${escapeMd(row.user_name || "Пользователь")}\n📝 ${escapeMd(row.comment || "Без комментария")}`;
      await ctx.reply(message, md(Markup.inlineKeyboard([
        [Markup.button.callback("✏️ Изменить сумму", `edit_expense_${row.id}`)],
        [Markup.button.callback("🗑 Удалить", `delete_${row.id}`)]
      ])));
    }
    return;
  }
  if (state?.step === "awaiting_edit_amount") {
    const amount = parseAmount(text);
    if (amount === null) return ctx.reply("⚠️ Введи положительную сумму до 1 000 000 000 ₽. Например: 120 или 120,50.", md(cfg.cancelInline));
    const expense = await dbGet("SELECT id, user_id, budget_type FROM expenses WHERE id = ?", [state.expenseId]);
    if (!expense) {
      userSteps.delete(userId);
      return ctx.reply("⚠️ Расход уже не найден. Обнови историю.", md(cfg.menuKeyboard));
    }
    const allowedIds = await getGroupIds(userId);
    if (Number(expense.user_id) !== Number(userId) && !(expense.budget_type === "family" && allowedIds.includes(Number(expense.user_id)))) {
      userSteps.delete(userId);
      return ctx.reply("⛔ Нет доступа к этому расходу.", md(cfg.menuKeyboard));
    }
    await dbRun("UPDATE expenses SET amount = ? WHERE id = ?", [amount, state.expenseId]);
    userSteps.delete(userId);
    return ctx.reply(`✅ Сумма расхода обновлена: *${formatAmount(amount)}*`, md(cfg.menuKeyboard));
  }
  if (state?.step === "awaiting_receipt_amount") {
    const amount = parseAmount(text);
    if (amount === null) return ctx.reply("⚠️ Введи корректную положительную сумму, например 12,50.", md(cfg.cancelInline));
    state.amount = amount;
    state.step = "awaiting_category";
    const buttons = cfg.CATEGORIES.map((category) => Markup.button.callback(category.label, `cat:${category.id}`));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    return ctx.reply(`✅ Сумма исправлена: *${formatAmount(amount)}*\n\n🏷 *Выбери категорию расходов:*`, md(Markup.inlineKeyboard(rows)));
  }
  if (state?.step === "awaiting_amount") {
    const amount = parseAmount(text);
    if (amount === null) return ctx.reply("⚠️ Введи положительную сумму до 1 000 000 000 ₽. Например: 120 или 120,50.", md(cfg.cancelInline));
    state.amount = amount;
    state.step = "awaiting_category";
    const categories = Array.isArray(cfg.CATEGORIES) ? cfg.CATEGORIES : [];
    if (!categories.length) {
      userSteps.delete(userId);
      return ctx.reply("⚠️ Список категорий пуст. Проверь config.js.", md(cfg.menuKeyboard));
    }
    const buttons = categories.map((category) => Markup.button.callback(category.label, `cat:${category.id}`));
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
    return ctx.reply(`💰 Сумма: *${formatAmount(amount)}*\n\n🏷 *Выбери категорию расходов:*`, md(Markup.inlineKeyboard(keyboard)));
  }
  if (state?.step === "awaiting_comment") return finishExpense(ctx, text);
  if (state?.step === "awaiting_limit") {
    const amount = parseAmount(text);
    if (amount === null) return ctx.reply("⚠️ Введи положительный лимит до 1 000 000 000 ₽.", md(cfg.cancelInline));
    const limitType = state.limitType === "family" ? "family" : "personal";
    if (limitType === "family" && !(await getUserGroup(userId))) {
      userSteps.delete(userId);
      return ctx.reply("⚠️ Ты больше не состоишь в семейной группе. Лимит не изменён.", md(cfg.menuKeyboard));
    }
    await setUserLimit(userId, amount, limitType);
    userSteps.delete(userId);
    const label = limitType === "family" ? "семейного" : "личного";
    return ctx.reply(`🎉 *Месячный лимит ${label} бюджета сохранён: ${formatAmount(amount)}!*`, md(cfg.menuKeyboard));
  }
  if (state?.step === "awaiting_code") return joinFamilyGroup(ctx, text);
  return ctx.reply("Выбери действие на панели:", md(cfg.menuKeyboard));
});

bot.action('expense_manual_amount', async (ctx) => {
  userSteps.set(ctx.from.id, { step: 'awaiting_amount' });
  await ctx.answerCbQuery();
  return ctx.editMessageText('💰 *Введи сумму расхода:*', md(cfg.cancelInline));
});

bot.action('expense_scan_receipt', async (ctx) => {
  userSteps.set(ctx.from.id, { step: 'awaiting_receipt_photo' });
  await ctx.answerCbQuery();
  return ctx.editMessageText('🧾 *Отправь фотографию чека следующим сообщением.*\n\nСделай фото ровно, без бликов, чтобы были видны итоговая сумма и дата.', md(cfg.cancelInline));
});

bot.action('receipt_confirm', async (ctx) => {
  const state = userSteps.get(ctx.from.id);
  if (!state || state.step !== 'awaiting_receipt_review' || !Number.isFinite(state.amount)) {
    await ctx.answerCbQuery('Сначала отправь чек заново.', { show_alert: true });
    return;
  }
  state.step = 'awaiting_category';
  await ctx.answerCbQuery('Данные подтверждены');
  const buttons = cfg.CATEGORIES.map((category) => Markup.button.callback(category.label, `cat:${category.id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return ctx.editMessageText(`💰 Подтверждённая сумма: *${formatAmount(state.amount)}*\nВыбери категорию:`, md(Markup.inlineKeyboard(rows)));
});

bot.action('receipt_edit_amount', async (ctx) => {
  const state = userSteps.get(ctx.from.id);
  if (!state || state.step !== 'awaiting_receipt_review') return ctx.answerCbQuery('Чек не найден. Отправь его заново.');
  state.step = 'awaiting_receipt_amount';
  await ctx.answerCbQuery();
  return ctx.editMessageText(`✏️ Введи правильную сумму. Сейчас распознано: *${formatAmount(state.amount)}*`, md(cfg.cancelInline));
});

bot.action('receipt_manual_amount', async (ctx) => {
  const state = userSteps.get(ctx.from.id) || {};
  state.step = 'awaiting_receipt_amount';
  userSteps.set(ctx.from.id, state);
  await ctx.answerCbQuery();
  return ctx.editMessageText('✏️ Введи итоговую сумму с чека, например 12,50:', md(cfg.cancelInline));
});

bot.action('receipt_retry', async (ctx) => {
  userSteps.set(ctx.from.id, { step: 'awaiting_receipt_photo' });
  await ctx.answerCbQuery();
  return ctx.editMessageText('📷 Отправь другое, более чёткое фото чека.', md(cfg.cancelInline));
});

for (const period of Object.keys(PERIODS)) {
  bot.action(`stats_${period}`, async (ctx) => {
    await ctx.answerCbQuery();
    return sendStats(ctx, period, true);
  });
}

bot.action(/^cat:(.+)$/, async (ctx) => {
  const state = userSteps.get(ctx.from.id);
  if (!state || state.step !== "awaiting_category") return ctx.answerCbQuery("Начни добавление расхода заново.");
  const category = cfg.CATEGORIES.find((item) => item.id === ctx.match[1]);
  if (!category) return ctx.answerCbQuery("Категория не найдена.");
  state.category = category.label;
  await ctx.answerCbQuery();
  const groupId = await getUserGroup(ctx.from.id);
  if (groupId) {
    state.step = "awaiting_budget_type";
    return ctx.editMessageText("Куда записать расход?", md(Markup.inlineKeyboard([
      [Markup.button.callback("👤 Личный бюджет", "budget_personal")],
      [Markup.button.callback("👥 Семейный бюджет", "budget_family")],
      [Markup.button.callback("❌ Отмена", "cancel_action")]
    ])));
  }
  state.budgetType = "personal";
  state.step = "awaiting_comment";
  return ctx.editMessageText("📝 *Введи комментарий к трате или пропусти этот шаг:*", md(cfg.commentInline));
});

for (const [action, budgetType] of [["budget_personal", "personal"], ["budget_family", "family"]]) {
  bot.action(action, async (ctx) => {
    const state = userSteps.get(ctx.from.id);
    if (!state || state.step !== "awaiting_budget_type") return ctx.answerCbQuery("Начни добавление расхода заново.");
    if (budgetType === "family" && !(await getUserGroup(ctx.from.id))) return ctx.answerCbQuery("Сначала подключись к семейной группе.", { show_alert: true });
    state.budgetType = budgetType;
    state.step = "awaiting_comment";
    await ctx.answerCbQuery();
    const receiptLabel = state.receiptText ? `Чек${state.receiptMerchant ? `: ${state.receiptMerchant}` : ""}${state.receiptDate ? `, дата ${state.receiptDate}` : ""}` : "";
    const comment = state.quickDescription || receiptLabel;
    if (comment) return finishExpense(ctx, comment);
    return ctx.editMessageText("📝 *Введи комментарий к трате или пропусти этот шаг:*", md(cfg.commentInline));
  });
}

async function promptLimitChange(ctx, budgetType) {
  const userId = ctx.from.id;
  if (budgetType === "family" && !(await getUserGroup(userId))) {
    await ctx.answerCbQuery("Сначала подключись к семейной группе.", { show_alert: true });
    return;
  }
  userSteps.set(userId, { step: "awaiting_limit", limitType: budgetType });
  await ctx.answerCbQuery();
  const label = budgetType === "family" ? "семейного" : "личного";
  return ctx.editMessageText(`💰 *Введи новый месячный лимит ${label} бюджета:*`, md(cfg.cancelInline));
}

bot.action("edit_limit_prompt", async (ctx) => promptLimitChange(ctx, "personal"));
bot.action("edit_personal_limit", async (ctx) => promptLimitChange(ctx, "personal"));
bot.action("edit_family_limit", async (ctx) => promptLimitChange(ctx, "family"));

async function sendFamilyMembers(ctx, edit = false) {
  const userId = ctx.from.id;
  const groupId = await getUserGroup(userId);
  if (!groupId) {
    const text = "👥 *Семейная группа*\n\nСоздай группу или войди по коду приглашения.";
    return edit && ctx.callbackQuery
      ? ctx.editMessageText(text, md(cfg.familyInline))
      : ctx.reply(text, md(cfg.familyInline));
  }

  const group = await dbGet("SELECT created_by, invite_code FROM family_groups WHERE group_id = ?", [groupId]);
  const members = await dbAll(
    "SELECT user_id, first_name, username FROM settings WHERE group_id = ? OR group_code = ? ORDER BY user_id",
    [groupId, groupId]
  );
  const isCreator = Number(group?.created_by) === Number(userId);
  const lines = members.map((member, i) => {
    const displayName = member.first_name || `Участник ${i + 1}`;
    const username = member.username ? ` (@${member.username})` : "";
    const role = Number(member.user_id) === Number(group?.created_by) ? " — создатель" : "";
    return `${i + 1}. ${escapeMd(displayName)}${escapeMd(username)}${role}`;
  });
  const text = `👥 *Участники семейной группы*\n\n${lines.join("\n") || "Участники не найдены."}\n\nУчастников: *${members.length}/${MAX_GROUP_MEMBERS}*`;
  const rows = [];
  if (isCreator && members.length < MAX_GROUP_MEMBERS) {
    rows.push([Markup.button.callback("➕ Пригласить участника", "group_invite")]);
  }
  if (isCreator && members.some((m) => Number(m.user_id) !== Number(userId))) {
    rows.push([Markup.button.callback("➖ Удалить участника", "group_remove_menu")]);
  }
  rows.push([Markup.button.callback("🚪 Покинуть группу", "leave_group")]);
  rows.push([Markup.button.callback("⬅️ Назад", "family_menu")]);
  const keyboard = Markup.inlineKeyboard(rows);
  return edit && ctx.callbackQuery
    ? ctx.editMessageText(text, md(keyboard))
    : ctx.reply(text, md(keyboard));
}

bot.action("family_menu", async (ctx) => {
  await ctx.answerCbQuery();
  const groupId = await getUserGroup(ctx.from.id);
  if (groupId) return sendFamilyMembers(ctx, true);
  return ctx.editMessageText(
    "👥 *Семейный доступ*\n\nСоздай группу и передай код приглашения либо войди по коду партнёра.",
    md(cfg.familyInline)
  );
});

bot.action("group_invite", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const groupId = await getUserGroup(userId);
  if (!groupId) return ctx.editMessageText("Ты не состоишь в семейной группе.", md(cfg.familyInline));
  const group = await dbGet("SELECT created_by FROM family_groups WHERE group_id = ?", [groupId]);
  if (Number(group?.created_by) !== Number(userId)) {
    return ctx.answerCbQuery("Только создатель группы может приглашать участников.", { show_alert: true });
  }
  const members = await dbAll("SELECT user_id FROM settings WHERE group_id = ? OR group_code = ?", [groupId, groupId]);
  if (members.length >= MAX_GROUP_MEMBERS) {
    return ctx.editMessageText(`Достигнут лимит участников: ${MAX_GROUP_MEMBERS}.`, md(Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ К участникам", "family_menu")]
    ])));
  }
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const suffix = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join("");
  const inviteCode = `FAM-${suffix}`;
  const createdAt = new Date().toISOString();
  await dbRun("UPDATE family_groups SET invite_code = ?, invite_created_at = ? WHERE group_id = ?", [inviteCode, createdAt, groupId]);
  return ctx.editMessageText(
    `🔗 *Приглашение в семейную группу*\n\nКод: \`${inviteCode}\`\n\nКод действует 15 минут. Передай его человеку, которого хочешь добавить. После использования можно создать новый код.`,
    md(Markup.inlineKeyboard([[Markup.button.callback("⬅️ К участникам", "family_menu")]]))
  );
});

bot.action("group_remove_menu", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const groupId = await getUserGroup(userId);
  const group = groupId ? await dbGet("SELECT created_by FROM family_groups WHERE group_id = ?", [groupId]) : null;
  if (!groupId || Number(group?.created_by) !== Number(userId)) {
    return ctx.answerCbQuery("Удалять участников может только создатель группы.", { show_alert: true });
  }
  const members = await dbAll(
    "SELECT user_id, first_name, username FROM settings WHERE (group_id = ? OR group_code = ?) AND user_id != ? ORDER BY user_id",
    [groupId, groupId, userId]
  );
  if (!members.length) {
    return ctx.editMessageText("В группе нет других участников.", md(Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ К участникам", "family_menu")]
    ])));
  }
  const rows = members.map((member) => [
    Markup.button.callback(
      `🗑 ${String(member.first_name || "Участник").slice(0, 24)}${member.username ? ` (@${member.username})` : ""}`.slice(0, 60),
      `remove_member_${member.user_id}`
    )
  ]);
  rows.push([Markup.button.callback("⬅️ Назад", "family_menu")]);
  return ctx.editMessageText("Выбери участника, которого нужно удалить из семейной группы. Его прошлые расходы останутся в истории.", md(Markup.inlineKeyboard(rows)));
});

bot.action(/^remove_member_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const memberId = Number(ctx.match[1]);
  const groupId = await getUserGroup(userId);
  const group = groupId ? await dbGet("SELECT created_by FROM family_groups WHERE group_id = ?", [groupId]) : null;
  if (!groupId || Number(group?.created_by) !== Number(userId)) {
    return ctx.answerCbQuery("Только создатель группы может удалять участников.", { show_alert: true });
  }
  if (memberId === userId) return ctx.answerCbQuery("Нельзя удалить самого себя этой кнопкой. Используй «Покинуть группу».", { show_alert: true });
  const member = await dbGet("SELECT user_id FROM settings WHERE user_id = ? AND (group_id = ? OR group_code = ?)", [memberId, groupId, groupId]);
  if (!member) return ctx.answerCbQuery("Участник уже не состоит в группе.", { show_alert: true });
  await dbRun("UPDATE settings SET group_id = NULL, group_code = NULL, group_code_created_at = NULL WHERE user_id = ?", [memberId]);
  await ctx.answerCbQuery("Участник удалён");
  return sendFamilyMembers(ctx, true);
});

bot.action("back_to_settings", async (ctx) => {
  await ctx.answerCbQuery();
  userSteps.delete(ctx.from.id);
  return sendSettingsMessage(ctx, ctx.from.id);
});

bot.action("create_group", async (ctx) => {
  await ctx.answerCbQuery();
  return createFamilyGroup(ctx);
});

bot.action("join_group_prompt", async (ctx) => {
  await ctx.answerCbQuery();
  userSteps.set(ctx.from.id, { step: "awaiting_code" });
  return ctx.editMessageText("🔑 *Введи код семейной группы (например, FAM-ABC234):*", md(cfg.cancelInline));
});

bot.action("leave_group", async (ctx) => {
  await ctx.answerCbQuery();
  return leaveFamilyGroup(ctx);
});

bot.action("skip_comment", async (ctx) => {
  await ctx.answerCbQuery();
  return finishExpense(ctx, "Без комментария");
});

bot.action("cancel_action", async (ctx) => {
  userSteps.delete(ctx.from.id);
  await ctx.answerCbQuery();
  return ctx.reply("Действие отменено.", md(cfg.menuKeyboard));
});

bot.action(/^edit_expense_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const expenseId = Number(ctx.match[1]);
  const expense = await dbGet("SELECT id, user_id, budget_type FROM expenses WHERE id = ?", [expenseId]);
  if (!expense) return ctx.answerCbQuery("Расход не найден.");
  const allowedIds = await getGroupIds(userId);
  if (Number(expense.user_id) !== Number(userId) && !(expense.budget_type === "family" && allowedIds.includes(Number(expense.user_id)))) {
    return ctx.answerCbQuery("Нет доступа к этому расходу.", { show_alert: true });
  }
  userSteps.set(userId, { step: "awaiting_edit_amount", expenseId });
  await ctx.answerCbQuery();
  return ctx.reply("✏️ *Введи новую сумму расхода:*", md(cfg.cancelInline));
});

bot.action(/^delete_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const expenseId = Number(ctx.match[1]);
  const expense = await dbGet("SELECT id, user_id, budget_type FROM expenses WHERE id = ?", [expenseId]);
  if (!expense) return ctx.answerCbQuery("Расход не найден.");
  const allowedIds = await getGroupIds(userId);
  if (Number(expense.user_id) !== Number(userId) && !(expense.budget_type === "family" && allowedIds.includes(Number(expense.user_id)))) {
    return ctx.answerCbQuery("Нет доступа к этому расходу.", { show_alert: true });
  }
  await dbRun("DELETE FROM expenses WHERE id = ? AND user_id = ?", [expenseId, expense.user_id]);
  await ctx.answerCbQuery("Удалено!");
  return ctx.editMessageText("❌ *Расход успешно удалён.*", md());
});

bot.catch((err, ctx) => {
  console.error(`Ошибка Telegram update ${ctx?.update?.update_id ?? "unknown"}:`, err);
});

server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/health") {
    res.writeHead(shuttingDown ? 503 : 200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(shuttingDown ? "Shutting down" : "OK");
  }
  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Finance bot is running");
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  return res.end("Not found");
});

server.on("error", (err) => console.error("Ошибка HTTP-сервера:", err));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Остановка бота: ${signal}`);
  bot.stop(signal);
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve, reject) => db.close((err) => err ? reject(err) : resolve()));
}

process.once("SIGINT", () => shutdown("SIGINT").catch((err) => { console.error(err); process.exitCode = 1; }));
process.once("SIGTERM", () => shutdown("SIGTERM").catch((err) => { console.error(err); process.exitCode = 1; }));

async function start() {
  try {
    await initDb();
    await new Promise((resolve, reject) => {
      server.listen(Number(process.env.PORT) || 3000, resolve);
      server.once("error", reject);
    });
    console.log("HTTP-сервер запущен.");
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log("Бот успешно запущен!");
  } catch (err) {
    console.error("Ошибка запуска бота:", err);
    process.exitCode = 1;
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    try { await new Promise((resolve) => db.close(() => resolve())); } catch {}
  }
}

start();
