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
const db = new sqlite3.Database(
  path.join(__dirname, "expenses.db")
);

const userSteps = new Map();

const MAX_AMOUNT = 1_000_000_000;
const MAX_COMMENT_LENGTH = 1000;
const MAX_GROUP_MEMBERS = 2;
const GROUP_CODE_TTL = 15 * 60 * 1000;

let shuttingDown = false;
let server;

function md(extra = {}) {
  return { parse_mode: "Markdown", ...extra };
}

function escapeMd(value) {
  return String(value ?? "").replace(/([_*`\[\]\\])/g, "\\$1");
}

function formatAmount(value) {
  return `${Number(value || 0).toLocaleString("ru-RU", {
    maximumFractionDigits: 2
  })} ₽`;
}

function parseAmount(value) {
  const normalized = String(value)
    .trim()
    .replace(/\s/g, "")
    .replace(",", ".");

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const amount = Number(normalized);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_AMOUNT
  ) {
    return null;
  }

  return amount;
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
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      amount REAL,
      category TEXT,
      comment TEXT,
      user_name TEXT,
      date TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY,
      monthly_limit REAL,
      group_code TEXT,
      group_code_created_at TEXT
    )
  `);

  const columns = await dbAll("PRAGMA table_info(settings)");

  if (!columns.some((column) =>
    column.name === "group_code_created_at"
  )) {
    await dbRun(
      "ALTER TABLE settings ADD COLUMN group_code_created_at TEXT"
    );
  }

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_expenses_user_date
    ON expenses(user_id, date)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_settings_group
    ON settings(group_code)
  `);
}

async function getUserGroup(userId) {
  const row = await dbGet(
    "SELECT group_code FROM settings WHERE user_id = ?",
    [userId]
  );

  return row?.group_code || null;
}

async function getGroupIds(userId) {
  const group = await getUserGroup(userId);

  if (!group) return [userId];

  const members = await dbAll(
    "SELECT user_id FROM settings WHERE group_code = ?",
    [group]
  );

  const ids = members.map((member) => member.user_id);

  return ids.length ? ids : [userId];
}

async function getUserLimit(userId) {
  const group = await getUserGroup(userId);

  const row = group
    ? await dbGet(
        `SELECT monthly_limit
         FROM settings
         WHERE group_code = ?
         ORDER BY user_id ASC
         LIMIT 1`,
        [group]
      )
    : await dbGet(
        "SELECT monthly_limit FROM settings WHERE user_id = ?",
        [userId]
      );

  const limit = Number(row?.monthly_limit);

  return Number.isFinite(limit) && limit > 0
    ? limit
    : cfg.DEFAULT_LIMIT;
}

async function setUserLimit(userId, amount) {
  const group = await getUserGroup(userId);

  await dbRun(
    `INSERT INTO settings (user_id, monthly_limit)
     VALUES (?, ?)
     ON CONFLICT(user_id)
     DO UPDATE SET monthly_limit = excluded.monthly_limit`,
    [userId, amount]
  );

  if (group) {
    await dbRun(
      "UPDATE settings SET monthly_limit = ? WHERE group_code = ?",
      [amount, group]
    );
  }
}

async function sendSettingsMessage(ctx, userId) {
  const group = await getUserGroup(userId);
  const limit = await getUserLimit(userId);

  const status = group
    ? `👥 Группа: *${escapeMd(group)}*`
    : "👤 Личный аккаунт";

  const message =
    `⚙️ *Настройки бюджета*\n\n` +
    `Текущий статус: ${status}\n` +
    `Месячный лимит: *${formatAmount(limit)}*\n\n` +
    "Выберите действие кнопками ниже:";

  if (ctx.callbackQuery) {
    return ctx.editMessageText(message, md(cfg.settingsInline));
  }

  return ctx.reply(message, md(cfg.settingsInline));
}
const PERIODS = {
  today: {
    label: "Сегодня",
    condition: "date >= date('now')"
  },
  week: {
    label: "Последние 7 дней",
    condition: "date >= date('now', '-6 days')"
  },
  month: {
    label: "Текущий месяц",
    condition: "date >= date('now', 'start of month')"
  }
};

function statsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📅 Сегодня", "stats_today"),
      Markup.button.callback("📆 7 дней", "stats_week")
    ],
    [
      Markup.button.callback("🗓 Месяц", "stats_month")
    ]
  ]);
}

async function sendStats(ctx, period = "month", edit = false) {
  const selected = PERIODS[period] ? period : "month";
  const userId = ctx.from.id;

  const group = await getUserGroup(userId);
  const ids = await getGroupIds(userId);
  const limit = await getUserLimit(userId);
  const placeholders = ids.map(() => "?").join(", ");

  const rows = await dbAll(
    `SELECT category, SUM(amount) AS total
     FROM expenses
     WHERE user_id IN (${placeholders})
       AND ${PERIODS[selected].condition}
     GROUP BY category
     ORDER BY total DESC`,
    ids
  );

  const total = rows.reduce(
    (sum, row) => sum + Number(row.total || 0),
    0
  );

  const lines = rows.length
    ? rows.map((row) =>
        `${escapeMd(row.category)}: *${formatAmount(row.total)}*`
      ).join("\n")
    : "🌱 *Траты за выбранный период отсутствуют!*";

  const remaining = limit - total;
  const percent = limit > 0
    ? Math.round((total / limit) * 100)
    : 0;

  const remainingText = remaining >= 0
    ? `📉 Осталось бюджета: ${formatAmount(remaining)}`
    : `⚠️ Лимит превышен на ${formatAmount(Math.abs(remaining))}!`;

  const title = group
    ? "🧾 *Семейный отчёт*"
    : "🧾 *Ваш отчёт*";

  const message =
    `${title}\n` +
    `📆 Период: *${PERIODS[selected].label}*\n` +
    `${cfg.DIVIDER}\n${lines}\n` +
    `${cfg.DIVIDER}\n` +
    `💰 Месячный лимит: ${formatAmount(limit)}\n` +
    `${remainingText}\n` +
    `📊 Расходовано за период: ${percent}% от лимита`;

  if (edit && ctx.callbackQuery) {
    return ctx.editMessageText(message, md(statsKeyboard()));
  }

  return ctx.reply(message, md(statsKeyboard()));
}

async function finishExpense(ctx, comment) {
  const userId = ctx.from.id;
  const state = userSteps.get(userId);

  if (!state || state.step !== "awaiting_comment") {
    return ctx.reply(
      "↩️ Начни добавление расхода заново.",
      md(cfg.menuKeyboard)
    );
  }

  if (
    !Number.isFinite(state.amount) ||
    state.amount <= 0 ||
    state.amount > MAX_AMOUNT ||
    !state.category
  ) {
    userSteps.delete(userId);

    return ctx.reply(
      "⚠️ Данные расхода некорректны. Попробуй ещё раз.",
      md(cfg.menuKeyboard)
    );
  }

  await dbRun(
    `INSERT INTO expenses
      (user_id, amount, category, comment, user_name, date)
     VALUES (?, ?, ?, ?, ?, date('now'))`,
    [
      userId,
      state.amount,
      state.category,
      String(comment || "Без комментария").slice(
        0,
        MAX_COMMENT_LENGTH
      ),
      String(ctx.from.first_name || "Пользователь").slice(0, 100)
    ]
  );

  const group = await getUserGroup(userId);

  userSteps.delete(userId);

  const message = group
    ? `✅ *Расход записан в общий семейный бюджет (${escapeMd(group)})!*`
    : "✅ *Расход успешно записан в ваш личный бюджет!*";

  return ctx.reply(message, md(cfg.menuKeyboard));
}
bot.start(async (ctx) => {
  return ctx.reply(cfg.START_TEXT, md(cfg.menuKeyboard));
});

  const creator = await dbGet(
    `SELECT user_id, group_code_created_at, monthly_limit
     FROM settings
     WHERE group_code = ?
     ORDER BY user_id ASC
     LIMIT 1`,
    [code]
  );

  if (!creator || !creator.group_code_created_at) {
    return ctx.reply(
      "❌ Код не найден. Попроси партнёра создать новый.",
      md(cfg.cancelInline)
    );
  }

  if (creator.user_id === userId) {
    return ctx.reply(
      "ℹ️ Это твоя собственная группа.",
      md(cfg.menuKeyboard)
    );
  }

  const createdAt = Date.parse(creator.group_code_created_at);
  const elapsed = Date.now() - createdAt;

  if (
    !Number.isFinite(createdAt) ||
    elapsed < 0 ||
    elapsed > GROUP_CODE_TTL
  ) {
    return ctx.reply(
      "⚠️ Код истёк. Попроси партнёра создать новый.",
      md(cfg.menuKeyboard)
    );
  }

  const existingGroup = await getUserGroup(userId);

  if (existingGroup && existingGroup !== code) {
    return ctx.reply(
      "⚠️ Сначала выйди из текущей группы.",
      md(cfg.menuKeyboard)
    );
  }

  const members = await dbAll(
    "SELECT user_id FROM settings WHERE group_code = ?",
    [code]
  );

  if (
    !members.some((member) => member.user_id === userId) &&
    members.length >= MAX_GROUP_MEMBERS
  ) {
    return ctx.reply(
      "⚠️ Группа уже заполнена.",
      md(cfg.menuKeyboard)
    );
  }

  const limit = Number(creator.monthly_limit) > 0
    ? Number(creator.monthly_limit)
    : cfg.DEFAULT_LIMIT;

  await dbRun(
    `INSERT INTO settings (user_id, monthly_limit, group_code)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       monthly_limit = excluded.monthly_limit,
       group_code = excluded.group_code`,
    [userId, limit, code]
  );

  await dbRun(
    "UPDATE settings SET monthly_limit = ? WHERE group_code = ?",
    [limit, code]
  );

  userSteps.delete(userId);

  return ctx.reply(
    `🎉 *Ты подключился к семейной группе ${escapeMd(code)}!*`,
    md(cfg.menuKeyboard)
  );
}

  if (text === "⚙️ Настройки") {
    userSteps.delete(userId);
    return sendSettingsMessage(ctx, userId);
  }

  if (text === "📊 Статистика") {
    userSteps.delete(userId);

    return ctx.reply(
      "📊 *Выберите период статистики:*",
      md(statsKeyboard())
    );
  }

  if (text === "📜 История и удаление") {
    userSteps.delete(userId);

    const ids = await getGroupIds(userId);
    const placeholders = ids.map(() => "?").join(", ");

    const rows = await dbAll(
      `SELECT id, user_id, amount, category, comment, user_name, date
       FROM expenses
       WHERE user_id IN (${placeholders})
       ORDER BY id DESC
       LIMIT 5`,
      ids
    );

    if (!rows.length) {
      return ctx.reply(
        "🌱 История трат пуста.",
        md(cfg.menuKeyboard)
      );
    }

    await ctx.reply("📋 *Последние 5 расходов:*", md());

    for (const row of rows) {
      const message =
        `🧾 *${escapeMd(row.category)}*\n` +
        `Сумма: *${formatAmount(row.amount)}*\n` +
        `📅 Дата: ${escapeMd(row.date)}\n` +
        `✍️ Кто: ${escapeMd(row.user_name || "Пользователь")}\n` +
        `📝 ${escapeMd(row.comment || "Без комментария")}`;

      await ctx.reply(
        message,
        md(Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🗑 Удалить",
              `delete_${row.id}`
            )
          ]
        ]))
      );
    }

    return;
  }

  if (state?.step === "awaiting_amount") {
    const amount = parseAmount(text);

    if (amount === null) {
      return ctx.reply(
        "⚠️ Введи положительную сумму до 1 000 000 000 ₽. " +
        "Например: 120 или 120,50.",
        md(cfg.cancelInline)
      );
    }

    state.amount = amount;
    state.step = "awaiting_category";

    const categories = Array.isArray(cfg.CATEGORIES)
      ? cfg.CATEGORIES
      : [];

    if (!categories.length) {
      userSteps.delete(userId);

      return ctx.reply(
        "⚠️ Список категорий пуст. Проверь config.js.",
        md(cfg.menuKeyboard)
      );
    }

    const buttons = categories.map((category) =>
      Markup.button.callback(
        category.label,
        `cat:${category.id}`
      )
    );

    const keyboard = [];

    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2));
    }

    return ctx.reply(
      `💰 Сумма: *${formatAmount(amount)}*\n\nВыберите категорию:`,
      md(Markup.inlineKeyboard(keyboard))
    );
  }

  if (state?.step === "awaiting_comment") {
    return finishExpense(
      ctx,
      text.trim() || "Без комментария"
    );
  }

  if (state?.step === "awaiting_limit") {
    const amount = parseAmount(text);

    if (amount === null) {
      return ctx.reply(
        "⚠️ Введи положительный лимит до 1 000 000 000 ₽.",
        md(cfg.cancelInline)
      );
    }

    await setUserLimit(userId, amount);
    userSteps.delete(userId);

    return ctx.reply(
      `🎉 *Месячный лимит сохранён: ${formatAmount(amount)}!*`,
      md(cfg.menuKeyboard)
    );
  }

  if (state?.step === "awaiting_code") {
    return ctx.reply(
      "⏳ Подключение к группе будет обработано в следующей части.",
      md(cfg.cancelInline)
    );
  }

  return ctx.reply(
    "Выбери действие на панели:",
    md(cfg.menuKeyboard)
  );
});

for (const period of Object.keys(PERIODS)) {
  bot.action(`stats_${period}`, async (ctx) => {
    await ctx.answerCbQuery();
    return sendStats(ctx, period, true);
  });
}

bot.action(/^cat:(.+)$/, async (ctx) => {
  const state = userSteps.get(ctx.from.id);

  if (!state || state.step !== "awaiting_category") {
    return ctx.answerCbQuery(
      "Начни добавление расхода заново."
    );
  }

  const category = cfg.CATEGORIES.find(
    (item) => item.id === ctx.match[1]
  );

  if (!category) {
    return ctx.answerCbQuery("Категория не найдена.");
  }

  state.category = category.label;
  state.step = "awaiting_comment";

  await ctx.answerCbQuery();

  return ctx.editMessageText(
    "📝 *Введи комментарий к трате или пропусти этот шаг:*",
    md(cfg.commentInline)
  );
});
bot.action("edit_limit_prompt", async (ctx) => {
  await ctx.answerCbQuery();

  userSteps.set(ctx.from.id, { step: "awaiting_limit" });

  return ctx.editMessageText(
    "💰 *Введи сумму нового месячного лимита:*",
    md(cfg.cancelInline)
  );
});

bot.action("family_menu", async (ctx) => {
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    "👥 *Семейный доступ*\n\n" +
    "Создай группу и передай код партнёру либо войди по коду.",
    md(cfg.familyInline)
  );
});

bot.action("back_to_settings", async (ctx) => {
  await ctx.answerCbQuery();
  userSteps.delete(ctx.from.id);

  return sendSettingsMessage(ctx, ctx.from.id);
});

bot.action("create_group", async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id;

  if (await getUserGroup(userId)) {
    return ctx.editMessageText(
      "Ты уже состоишь в семейной группе.",
      md(cfg.familyInline)
    );
  }

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  let existing;

  do {
    let suffix = "";

    for (let i = 0; i < 6; i++) {
      suffix += chars[crypto.randomInt(chars.length)];
    }

    code = `FAM-${suffix}`;

    existing = await dbGet(
      "SELECT user_id FROM settings WHERE group_code = ?",
      [code]
    );
  } while (existing);

  const limit = await getUserLimit(userId);
  const createdAt = new Date().toISOString();

  await dbRun(
    `INSERT INTO settings
      (user_id, monthly_limit, group_code, group_code_created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       monthly_limit = excluded.monthly_limit,
       group_code = excluded.group_code,
       group_code_created_at = excluded.group_code_created_at`,
    [userId, limit, code, createdAt]
  );

  return ctx.editMessageText(
    `🎉 *Семейная группа создана!*\n\n` +
    `🔑 Секретный код: \`${code}\`\n\n` +
    "⏰ Код действует 15 минут. Передай его партнёру. " +
    "Для подключения нужно нажать «Войти по коду» и отправить код.",
    md(cfg.familyInline)
  );
});

bot.action("join_group_prompt", async (ctx) => {
  await ctx.answerCbQuery();

  userSteps.set(ctx.from.id, { step: "awaiting_code" });

  return ctx.editMessageText(
    "🔑 *Введи код семейной группы (например, FAM-ABC234):*",
    md(cfg.cancelInline)
  );
});

bot.action("skip_comment", async (ctx) => {
  await ctx.answerCbQuery();

  return finishExpense(ctx, "Без комментария");
});

bot.action("cancel_action", async (ctx) => {
  userSteps.delete(ctx.from.id);

  await ctx.answerCbQuery();

  return ctx.reply(
    "Действие отменено.",
    md(cfg.menuKeyboard)
  );
});

bot.action(/^delete_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const expenseId = Number(ctx.match[1]);

  const expense = await dbGet(
    "SELECT id, user_id FROM expenses WHERE id = ?",
    [expenseId]
  );

  if (!expense) {
    return ctx.answerCbQuery("Расход не найден.");
  }

  const allowedIds = await getGroupIds(userId);

  if (!allowedIds.includes(expense.user_id)) {
    return ctx.answerCbQuery(
      "Нет доступа к этому расходу.",
      { show_alert: true }
    );
  }

  await dbRun(
    "DELETE FROM expenses WHERE id = ?",
    [expenseId]
  );

  await ctx.answerCbQuery("Удалено!");

  return ctx.editMessageText(
    "❌ *Расход успешно удалён.*",
    md()
  );
});
bot.catch((err, ctx) => {
  console.error(
    `Ошибка Telegram update ${ctx?.update?.update_id ?? "unknown"}:`,
    err
  );
});

server = http.createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/health") {
    res.writeHead(404);
    return res.end("Not found");
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Live");
});

server.on("error", (err) => {
  console.error("Ошибка HTTP-сервера:", err);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Остановка бота: ${signal}`);

  bot.stop(signal);

  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }

  db.close((err) => {
    if (err) {
      console.error("Ошибка закрытия базы данных:", err);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function start() {
  try {
    await initDb();

    // Переключаем Telegram на polling.
    await bot.telegram.deleteWebhook();

    await bot.launch();

    console.log("Бот успешно запущен!");
  } catch (err) {
    console.error("Ошибка запуска бота:", err);
    process.exitCode = 1;
  }
}

server.listen(Number(process.env.PORT) || 3000, () => {
  console.log("HTTP-сервер запущен.");
});

start();