require("dotenv").config();
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { Telegraf, Markup } = require("telegraf");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Нет BOT_TOKEN. Добавь его в файл .env");
  process.exit(1);
}

const bot = new Telegraf(token);
const db = new sqlite3.Database(path.join(__dirname, "expenses.db"));
const userSteps = new Map();

const CATEGORIES = [
  { id: "supermarket", label: "🛒 Супермаркеты" },
  { id: "cafe", label: "🍔 Кафе и рестораны" },
  { id: "transport", label: "🚗 Транспорт и авто" },
  { id: "housing", label: "🏠 Жилье и ЖКХ" },
  { id: "health", label: "💊 Здоровье и аптеки" },
  { id: "shopping", label: "🛍 Одежда и шопинг" },
  { id: "comms", label: "📱 Связь и интернет" },
  { id: "other", label: "🌀 Иные расходы" },
];

const DIVIDER = "──────────────────";
let MONTHLY_LIMIT = 50000;

const START_TEXT = [
  "👋 *Привет! Я твой персональный финансовый ассистент.*",
  "",
  "Я помогу тебе контролировать бюджет и анализировать траты.",
  "",
  "🎯 *Что я умею:*",
  "• Быстро записывать расходы по категориям",
  "• Выводить детальную статистику",
  "",
  "Выбери действие на панели внизу экрана:",
].join("\n");

const BTN_ADD = "➕ Добавить расход";
const BTN_STATS = "📊 Статистика";
const BTN_HISTORY = "📜 История и удаление";

const menuKeyboard = Markup.keyboard([[BTN_ADD], [BTN_STATS, BTN_HISTORY]]).resize();

const cancelKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("❌ Отмена", "cancel_add")],
]);

const commentKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("⏭ Пропустить", "skip_comment")],
  [Markup.button.callback("❌ Отмена", "cancel_add")],
]);

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

const categoryKeyboard = Markup.inlineKeyboard([
  ...chunk(CATEGORIES, 2).map((row) =>
    row.map((item) => Markup.button.callback(item.label, `category:${item.id}`))
  ),
  [Markup.button.callback("❌ Отмена", "cancel_add")],
]);

const periodKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback("За сегодня", "stats_today"),
    Markup.button.callback("За неделю", "stats_week"),
    Markup.button.callback("За месяц", "stats_month"),
  ],
]);

function md(extra) {
  return extra ? { parse_mode: "Markdown", ...extra } : { parse_mode: "Markdown" };
}

function escapeMarkdown(text) {
  return String(text).replace(/([_*`\[])/g, "\\$1");
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function formatAmount(amount) {
  const [intPart, fracPart] = Number(amount).toFixed(2).split(".");
  const withSpaces = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  if (fracPart === "00") {
    return `${withSpaces} ₽`;
  }
  return `${withSpaces},${fracPart} ₽`;
}

function parseAmount(text) {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return amount;
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function initDb() {
  return dbRun(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      comment TEXT,
      date TEXT NOT NULL
    )
  `);
}

function saveExpense({ userId, amount, category, comment }) {
  return dbRun(
    `INSERT INTO expenses (user_id, amount, category, comment, date)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, amount, category, comment, new Date().toISOString()]
  );
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function startOfWeek() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - daysFromMonday);
  return date.toISOString();
}

function startOfMonth() {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

const STAT_PERIODS = {
  today: { title: "за сегодня", from: startOfToday },
  week: { title: "за неделю", from: startOfWeek },
  month: { title: "за месяц", from: startOfMonth },
};

function getUserExpensesFrom(userId, fromIso) {
  return dbAll(
    `SELECT amount, category FROM expenses
     WHERE user_id = ? AND date >= ?
     ORDER BY id ASC`,
    [userId, fromIso]
  );
}

function getRecentExpenses(userId, limit = 5) {
  return dbAll(
    `SELECT id, amount, category, comment, date
     FROM expenses
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [userId, limit]
  );
}

function deleteExpenseById(id, userId) {
  return dbRun(`DELETE FROM expenses WHERE id = ? AND user_id = ?`, [id, userId]);
}

function buildHistoryItem(expense) {
  const lines = [
    "🧾 *Трата*",
    DIVIDER,
    escapeMarkdown(expense.category),
    `*${formatAmount(expense.amount)}*`,
    `📅 ${formatDate(expense.date)}`,
  ];

  if (expense.comment) {
    lines.push(`📝 ${escapeMarkdown(expense.comment)}`);
  }

  return lines.join("\n");
}

function deleteKeyboard(expenseId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("❌ Удалить эту трату", `delete_${expenseId}`)],
  ]);
}

function sumAmounts(expenses) {
  return expenses.reduce((sum, item) => sum + Number(item.amount), 0);
}

function buildBudgetBlock(monthSpent) {
  const remaining = MONTHLY_LIMIT - monthSpent;
  const percent = MONTHLY_LIMIT > 0 ? Math.round((monthSpent / MONTHLY_LIMIT) * 100) : 0;
  const remainingLine =
    remaining >= 0
      ? `📉 Осталось: ${formatAmount(remaining)}`
      : `⚠️ Лимит превышен на ${formatAmount(Math.abs(remaining))}!`;

  return [
    DIVIDER,
    `💰 Месячный лимит: ${formatAmount(MONTHLY_LIMIT)}`,
    remainingLine,
    `📊 Расходовано: ${percent}% от бюджета`,
  ].join("\n");
}

function buildStatsReceipt(userExpenses, { periodTitle, monthSpent }) {
  const budgetBlock = buildBudgetBlock(monthSpent);

  if (userExpenses.length === 0) {
    return [
      `🧾 *Отчёт ${periodTitle}*`,
      "",
      "🌱 *Траты отсутствуют. Твой кошелек в идеальном порядке!*",
      "",
      budgetBlock,
    ].join("\n");
  }

  const total = sumAmounts(userExpenses);
  const lines = CATEGORIES.map((category) => {
    const sum = userExpenses
      .filter((item) => item.category === category.label)
      .reduce((acc, item) => acc + Number(item.amount), 0);
    return `${category.label}\n${formatAmount(sum)}`;
  });

  return [
    `🧾 *Отчёт ${periodTitle}*`,
    "",
    DIVIDER,
    ...lines,
    DIVIDER,
    `*Итого: ${formatAmount(total)}*`,
    budgetBlock,
  ].join("\n");
}

async function finishExpense(ctx, comment) {
  const userId = ctx.from.id;
  const state = userSteps.get(userId);

  if (!state || state.step !== "awaiting_comment") {
    return ctx.reply("↩️ Сначала нажми *«Добавить расход»* на панели внизу.", md());
  }

  await saveExpense({
    userId,
    amount: state.amount,
    category: state.category,
    comment,
  });
  userSteps.delete(userId);

  await ctx.reply("✅ *Расход успешно записан!*", md());
}

async function startAddExpense(ctx) {
  userSteps.set(ctx.from.id, { step: "awaiting_amount" });
  await ctx.reply("💰 *Введите сумму расхода:*", md(cancelKeyboard));
}

async function showStats(ctx) {
  await ctx.reply("📅 Выберите период для просмотра статистики:", md(periodKeyboard));
}

async function sendPeriodStats(ctx, periodKey) {
  const period = STAT_PERIODS[periodKey];
  const userId = ctx.from.id;
  const [periodExpenses, monthExpenses] = await Promise.all([
    getUserExpensesFrom(userId, period.from()),
    getUserExpensesFrom(userId, startOfMonth()),
  ]);

  const receipt = buildStatsReceipt(periodExpenses, {
    periodTitle: period.title,
    monthSpent: sumAmounts(monthExpenses),
  });

  if (ctx.callbackQuery) {
    return ctx.editMessageText(receipt, md());
  }
  return ctx.reply(receipt, md());
}

async function showHistory(ctx) {
  const items = await getRecentExpenses(ctx.from.id, 5);

  if (items.length === 0) {
    return ctx.reply("История трат пуста", md());
  }

  await ctx.reply("📜 *Последние 5 трат:*", md());
  for (const expense of items) {
    await ctx.reply(buildHistoryItem(expense), md(deleteKeyboard(expense.id)));
  }
}

bot.start((ctx) => {
  userSteps.delete(ctx.from.id);
  return ctx.reply(START_TEXT, md(menuKeyboard));
});

bot.action("add_expense", async (ctx) => {
  await ctx.answerCbQuery();
  await startAddExpense(ctx);
});

bot.action(/^stats_(today|week|month)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await sendPeriodStats(ctx, ctx.match[1]);
});

bot.action("cancel_add", async (ctx) => {
  await ctx.answerCbQuery();
  userSteps.delete(ctx.from.id);
  await ctx.reply("❌ *Добавление расхода отменено.*", md());
});

bot.action(/^delete_(\d+)$/, async (ctx) => {
  const expenseId = Number(ctx.match[1]);
  const result = await deleteExpenseById(expenseId, ctx.from.id);

  if (!result.changes) {
    await ctx.answerCbQuery();
    return ctx.editMessageText("История трат пуста", md());
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText("Расход успешно удален из истории!", md());
});

bot.action("skip_comment", async (ctx) => {
  await ctx.answerCbQuery();
  await finishExpense(ctx, null);
});

bot.action(/^category:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = userSteps.get(userId);

  if (!state || state.step !== "awaiting_category") {
    await ctx.answerCbQuery();
    return ctx.reply("↩️ Сначала нажми *«Добавить расход»* на панели внизу.", md());
  }

  const categoryId = ctx.match[1];
  const category = CATEGORIES.find((item) => item.id === categoryId);
  if (!category) {
    await ctx.answerCbQuery();
    return ctx.reply("⚠️ Неизвестная категория. Выбери одну из кнопок ниже.", md());
  }

  userSteps.set(userId, {
    step: "awaiting_comment",
    amount: state.amount,
    category: category.label,
  });

  await ctx.answerCbQuery();
  await ctx.reply(
    "📝 *Добавьте короткий комментарий* к расходу или нажмите *Пропустить*.",
    md(commentKeyboard)
  );
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (text === BTN_ADD) {
    return startAddExpense(ctx);
  }
  if (text === BTN_STATS) {
    return showStats(ctx);
  }
  if (text === BTN_HISTORY) {
    return showHistory(ctx);
  }

  const state = userSteps.get(userId);

  if (!state) {
    return ctx.reply("👇 Выбери действие на панели внизу экрана.", md());
  }

  if (state.step === "awaiting_category") {
    return ctx.reply("🗂 Выбери категорию *кнопкой* под сообщением.", md(categoryKeyboard));
  }

  if (state.step === "awaiting_comment") {
    const comment = ctx.message.text.trim();
    if (!comment) {
      return ctx.reply(
        "📝 Введите комментарий или нажмите *Пропустить*.",
        md(commentKeyboard)
      );
    }
    return finishExpense(ctx, comment.slice(0, 200));
  }

  if (state.step !== "awaiting_amount") {
    return ctx.reply("👇 Выбери действие на панели внизу экрана.", md());
  }

  const amount = parseAmount(ctx.message.text);
  if (amount === null) {
    return ctx.reply(
      "⚠️ *Ошибка!* Пожалуйста, введите корректное число.",
      md(cancelKeyboard)
    );
  }

  userSteps.set(userId, { step: "awaiting_category", amount });
  await ctx.reply(
    `🗂 *Отлично! Теперь выберите категорию для суммы ${formatAmount(amount)}:*`,
    md(categoryKeyboard)
  );
});

initDb()
  .then(() => {
    bot.launch();
    console.log("Бот запущен");
  })
  .catch((err) => {
    console.error("Не удалось открыть базу данных:", err);
    process.exit(1);
  });

process.once("SIGINT", () => {
  bot.stop("SIGINT");
  db.close();
});
process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  db.close();
});
// Этот блок нужен специально для хостинга Render, чтобы он не закрывал приложение
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Бот запущен и работает!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер для Render запущен на порту ${PORT}`);
});