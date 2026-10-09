"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const http = require("http");
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
const MAX_GROUP_MEMBERS = 2;
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

function parseAmount(value) {
  const normalized = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 && amount <= MAX_AMOUNT ? amount : null;
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

async function getUserLimit(userId) {
  const groupId = await getUserGroup(userId);
  const row = groupId
    ? await dbGet("SELECT monthly_limit FROM settings WHERE COALESCE(group_id, group_code) = ? ORDER BY user_id ASC LIMIT 1", [groupId])
    : await dbGet("SELECT monthly_limit FROM settings WHERE user_id = ?", [userId]);
  const limit = Number(row?.monthly_limit);
  return Number.isFinite(limit) && limit > 0 ? limit : cfg.DEFAULT_LIMIT;
}

async function setUserLimit(userId, amount) {
  await withTransaction(async () => {
    const groupId = await getUserGroup(userId);
    await dbRun(`INSERT INTO settings (user_id, monthly_limit, group_id)
      VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_limit = excluded.monthly_limit`,
    [userId, amount, groupId]);
    if (groupId) {
      await dbRun("UPDATE settings SET monthly_limit = ? WHERE COALESCE(group_id, group_code) = ?", [amount, groupId]);
    }
  });
}

async function sendSettingsMessage(ctx, userId) {
  const groupId = await getUserGroup(userId);
  const limit = await getUserLimit(userId);
  const status = groupId ? `👥 Семейная группа: *${escapeMd(groupId)}*` : "👤 Личный аккаунт";
  const keyboard = groupId ? Markup.inlineKeyboard([
    [Markup.button.callback("💰 Изменить лимит бюджета", "edit_limit_prompt")],
    [Markup.button.callback("👥 Семейный доступ", "family_menu")]
  ]) : cfg.settingsInline;
  const message = `⚙️ *Настройки бюджета*\n\nТекущий статус: ${status}\nМесячный лимит: *${formatAmount(limit)}*\n\nВыберите действие кнопками ниже:`;
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
    [Markup.button.callback("📅 Сегодня", "stats_today"), Markup.button.callback("📆 7 дней", "stats_week")],
    [Markup.button.callback("🗓 Месяц", "stats_month")]
  ]);
}

async function sendStats(ctx, period = "month", edit = false) {
  const selected = PERIODS[period] ? period : "month";
  const userId = ctx.from.id;
  const groupId = await getUserGroup(userId);
  const ids = await getGroupIds(userId);
  const limit = await getUserLimit(userId);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await dbAll(`SELECT category, SUM(amount) AS total FROM expenses
    WHERE user_id IN (${placeholders}) AND date >= ? AND date <= ?
    GROUP BY category ORDER BY total DESC`, [...ids, periodStart(selected), dateInTimezone()]);
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const lines = rows.length
    ? rows.map((row) => `${escapeMd(row.category)}: *${formatAmount(row.total)}*`).join("\n")
    : "🌱 *Траты за выбранный период отсутствуют!*";
  const remaining = limit - total;
  const percent = limit > 0 ? Math.round((total / limit) * 100) : 0;
  const remainingText = remaining >= 0
    ? `📉 Осталось бюджета: ${formatAmount(remaining)}`
    : `⚠️ Лимит превышен на ${formatAmount(Math.abs(remaining))}!`;
  const title = groupId ? "🧾 *Семейный отчёт*" : "🧾 *Ваш отчёт*";
  const message = `${title}\n📆 Период: *${PERIODS[selected].label}*\n${cfg.DIVIDER}\n${lines}\n${cfg.DIVIDER}\n` +
    `💰 Месячный лимит: ${formatAmount(limit)}\n${remainingText}\n` +
    `📊 Потрачено за период от месячного лимита: ${percent}%`;
  if (edit && ctx.callbackQuery) return ctx.editMessageText(message, md(statsKeyboard()));
  return ctx.reply(message, md(statsKeyboard()));
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
  await dbRun(`INSERT INTO expenses (user_id, amount, category, comment, user_name, date)
    VALUES (?, ?, ?, ?, ?, ?)`, [userId, state.amount, state.category, cleanComment,
    String(ctx.from.first_name || "Пользователь").slice(0, 100), dateInTimezone()]);
  const groupId = await getUserGroup(userId);
  userSteps.delete(userId);
  return ctx.reply(groupId
    ? `✅ *Расход записан в общий семейный бюджет (${escapeMd(groupId)})!*`
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
    await dbRun(`INSERT INTO settings (user_id, monthly_limit, group_id)
      VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_limit = excluded.monthly_limit, group_id = excluded.group_id`,
      [userId, limit, groupId]);
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
      await dbRun(`INSERT INTO settings (user_id, monthly_limit, group_id)
        VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_limit = excluded.monthly_limit, group_id = excluded.group_id`,
        [userId, limit, invite.group_id]);
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

bot.start(async (ctx) => ctx.reply(cfg.START_TEXT, md(cfg.menuKeyboard)));

bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const state = userSteps.get(userId);

  if (text === "➕ Добавить расход") {
    userSteps.set(userId, { step: "awaiting_amount" });
    return ctx.reply("💰 *Введи сумму расхода:*", md(cfg.cancelInline));
  }
  if (text === "⚙️ Настройки") {
    userSteps.delete(userId);
    return sendSettingsMessage(ctx, userId);
  }
  if (text === "📊 Статистика") {
    userSteps.delete(userId);
    return ctx.reply("📊 *Выберите период статистики:*", md(statsKeyboard()));
  }
  if (text === "📜 История и удаление") {
    userSteps.delete(userId);
    const ids = await getGroupIds(userId);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await dbAll(`SELECT id, user_id, amount, category, comment, user_name, date
      FROM expenses WHERE user_id IN (${placeholders}) ORDER BY id DESC LIMIT 5`, ids);
    if (!rows.length) return ctx.reply("🌱 История трат пуста.", md(cfg.menuKeyboard));
    await ctx.reply("📋 *Последние 5 расходов:*", md());
    for (const row of rows) {
      const message = `🧾 *${escapeMd(row.category)}*\nСумма: *${formatAmount(row.amount)}*\n` +
        `📅 Дата: ${escapeMd(row.date)}\n✍️ Кто: ${escapeMd(row.user_name || "Пользователь")}\n📝 ${escapeMd(row.comment || "Без комментария")}`;
      await ctx.reply(message, md(Markup.inlineKeyboard([[Markup.button.callback("🗑 Удалить", `delete_${row.id}`)]])));
    }
    return;
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
    return ctx.reply(`💰 Сумма: *${formatAmount(amount)}*\n\nВыберите категорию:`, md(Markup.inlineKeyboard(keyboard)));
  }
  if (state?.step === "awaiting_comment") return finishExpense(ctx, text);
  if (state?.step === "awaiting_limit") {
    const amount = parseAmount(text);
    if (amount === null) return ctx.reply("⚠️ Введи положительный лимит до 1 000 000 000 ₽.", md(cfg.cancelInline));
    await setUserLimit(userId, amount);
    userSteps.delete(userId);
    return ctx.reply(`🎉 *Месячный лимит сохранён: ${formatAmount(amount)}!*`, md(cfg.menuKeyboard));
  }
  if (state?.step === "awaiting_code") return joinFamilyGroup(ctx, text);
  return ctx.reply("Выбери действие на панели:", md(cfg.menuKeyboard));
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
  state.step = "awaiting_comment";
  await ctx.answerCbQuery();
  return ctx.editMessageText("📝 *Введи комментарий к трате или пропусти этот шаг:*", md(cfg.commentInline));
});

bot.action("edit_limit_prompt", async (ctx) => {
  await ctx.answerCbQuery();
  userSteps.set(ctx.from.id, { step: "awaiting_limit" });
  return ctx.editMessageText("💰 *Введи сумму нового месячного лимита:*", md(cfg.cancelInline));
});

bot.action("family_menu", async (ctx) => {
  await ctx.answerCbQuery();
  const groupId = await getUserGroup(ctx.from.id);
  const keyboard = groupId ? Markup.inlineKeyboard([
    [Markup.button.callback("🚪 Покинуть группу", "leave_group")],
    [Markup.button.callback("⬅️ Назад в настройки", "back_to_settings")]
  ]) : cfg.familyInline;
  return ctx.editMessageText("👥 *Семейный доступ*\n\nСоздай группу и передай код партнёру либо войди по коду.", md(keyboard));
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

bot.action(/^delete_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const expenseId = Number(ctx.match[1]);
  const expense = await dbGet("SELECT id, user_id FROM expenses WHERE id = ?", [expenseId]);
  if (!expense) return ctx.answerCbQuery("Расход не найден.");
  const allowedIds = await getGroupIds(userId);
  if (!allowedIds.includes(Number(expense.user_id))) {
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
