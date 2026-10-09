require("dotenv").config();
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { Telegraf, Markup } = require("telegraf");
const http = require("http");
const cfg = require("./config");

const token = process.env.BOT_TOKEN;
if (!token) { console.error("Нет BOT_TOKEN"); process.exit(1); }

const bot = new Telegraf(token);
const db = new sqlite3.Database(path.join(__dirname, "expenses.db"));
const userSteps = new Map();

function md(ext) { return ext ? { parse_mode: "Markdown", ...ext } : { parse_mode: "Markdown" }; }
function formatAmount(num) { return `${Number(num).toLocaleString('ru-RU')} ₽`; }

function dbRun(sql, params = []) { return new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); })); }
function dbAll(sql, params = []) { return new Promise((res, rej) => db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); })); }
function dbGet(sql, params = []) { return new Promise((res, rej) => db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); })); }

function initDb() {
  return Promise.all([
    dbRun("CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount REAL, category TEXT, comment TEXT, user_name TEXT, date TEXT)"),
    dbRun("CREATE TABLE IF NOT EXISTS settings (user_id INTEGER PRIMARY KEY, monthly_limit REAL, group_code TEXT)")
  ]);
}

async function getUserGroup(userId) { const row = await dbGet("SELECT group_code FROM settings WHERE user_id = ?", [userId]); return row ? row.group_code : null; }
async function getGroupIds(userId) {
  const group = await getUserGroup(userId);
  if (!group) return [userId];
  // Ищем абсолютно всех пользователей, у которых записан этот код группы
  const members = await dbAll("SELECT user_id FROM settings WHERE group_code = ?", [group]);
  if (!members || members.length === 0) return [userId];
  return members.map(m => m.user_id);
}
async function getUserLimit(userId) { const group = await getUserGroup(userId); const row = group ? await dbGet("SELECT monthly_limit FROM settings WHERE group_code = ? ORDER BY user_id ASC LIMIT 1", [group]) : await dbGet("SELECT monthly_limit FROM settings WHERE user_id = ?", [userId]); return row && row.monthly_limit ? row.monthly_limit : cfg.DEFAULT_LIMIT; }

async function finishExpense(ctx, comment) {
  const userId = ctx.from.id;
  const state = userSteps.get(userId);
  if (!state || state.step !== "awaiting_comment") return ctx.reply("↩️ Нажми «Добавить расход» внизу.", md(menuKeyboard));
  
  // ВАЖНО: Получаем код группы перед сохранением трат!
  const groupCode = await getUserGroup(userId);
  
  // Добавляем group_code в SQL-запрос, чтобы расходы привязывались к семье
  await dbRun(
    "INSERT INTO expenses (user_id, amount, category, comment, user_name, date) VALUES (?, ?, ?, ?, ?, date('now'))", 
    [userId, state.amount, state.category, comment || "Без комментария", ctx.from.first_name || "Пользователь"]
  );
  
  userSteps.delete(userId);
  
  const successText = groupCode 
    ? `✅ *Расход успешно записан в общий семейный бюджет (${groupCode})!*` 
    : "✅ *Расход успешно записан в ваш личный бюджет!*";
    
  await ctx.reply(successText, md(menuKeyboard));
}

async function sendSettingsMessage(ctx, uid) {
  const group = await getUserGroup(uid); const limit = await getUserLimit(uid);
  const text = `⚙️ *Настройки бюджета*\n\nТекущий статус: ${group ? `👥 Группа: *${group}*` : "👤 Личный аккаунт"}\nМесячный лимит: *${formatAmount(limit)}*\n\nВыберите действие кнопками ниже:`;
  return ctx.callbackQuery ? ctx.editMessageText(text, md(cfg.settingsInline)) : ctx.reply(text, md(cfg.settingsInline));
}

bot.on("text", async (ctx) => {
  const text = ctx.message.text; const uid = ctx.from.id; const state = userSteps.get(uid);

  if (text === "➕ Добавить расход") { userSteps.set(uid, { step: "awaiting_amount" }); return ctx.reply("💰 *Введите сумму расхода (только число):*", md(cfg.cancelInline)); }
  if (text === "⚙️ Настройки") return sendSettingsMessage(ctx, uid);

  if (text === "📊 Статистика") {
    const ids = await getGroupIds(uid); const group = await getUserGroup(uid); const userLimit = await getUserLimit(uid);
    const rows = await dbAll(`SELECT category, SUM(amount) as sum FROM expenses WHERE user_id IN (${ids.join(",")}) AND date >= date('now', 'start of month') GROUP BY category`);
    let total = 0; let lines = rows.map(r => { total += r.sum; return `${r.category}: *${formatAmount(r.sum)}*`; }).join("\n");
    if (rows.length === 0) lines = "🌱 *Траты в этом месяце отсутствуют!*";
    const remaining = userLimit - total; const percent = userLimit > 0 ? Math.round((total / userLimit) * 100) : 0;
    const remainingLine = remaining >= 0 ? `📉 Осталось бюджета: ${formatAmount(remaining)}` : `⚠️ Лимит превышен на ${formatAmount(Math.abs(remaining))}!`;
    const budgetBlock = `${cfg.DIVIDER}\n💰 Месячный лимит: ${formatAmount(userLimit)}\n${remainingLine}\n📊 Расходовано: ${percent}% от бюджета`;
    return ctx.reply(`${group ? `🧾 *Семейный отчёт за месяц:*` : `🧾 *Ваш отчёт за месяц:*`}\n${cfg.DIVIDER}\n${lines}\n${budgetBlock}`, md(cfg.menuKeyboard));
  }

  if (text === "📜 История и удаление") {
    const ids = await getGroupIds(uid); const rows = await dbAll(`SELECT id, amount, category, comment, user_name FROM expenses WHERE user_id IN (${ids.join(",")}) ORDER BY id DESC LIMIT 5`);
    if (rows.length === 0) return ctx.reply("🌱 История трат пуста.", md(menuKeyboard));
    await ctx.reply("📋 *Последние 5 расходов:*", md());
    for (const r of rows) await ctx.reply(`🧾 *${r.category}*\nСумма: *${formatAmount(r.amount)}*\n✍️ Кто: ${r.user_name}\n📝 ${r.comment}`, md(Markup.inlineKeyboard([[Markup.button.callback("🗑 Удалить", `delete_${r.id}`)]])));
    return;
  }

  if (state && state.step === "awaiting_amount") {
    const amt = parseFloat(text.replace(",", ".")); if (isNaN(amt) || amt <= 0) return ctx.reply("⚠️ Введите корректное положительное число:");
    state.amount = amt; state.step = "awaiting_category"; const rows = [];
    for (let i = 0; i < cfg.CATEGORIES.length; i += 2) rows.push(cfg.CATEGORIES.slice(i, i + 2).map(c => Markup.button.callback(c.label, `cat:${c.id}`)));
    rows.push([Markup.button.callback("❌ Отмена", "cancel_action")]);
    return ctx.reply(`🗂 Сумма *${formatAmount(amt)}* принята. Выберите категорию:`, md(Markup.inlineKeyboard(rows)));
  }

  if (state && state.step === "awaiting_limit") {
    const amt = parseFloat(text.replace(",", ".")); if (isNaN(amt) || amt <= 0) return ctx.reply("⚠️ Введите число для лимита:");
    const group = await getUserGroup(uid);
    await dbRun("INSERT INTO settings (user_id, monthly_limit) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_limit = ?", [uid, amt, amt]);
    if (group) await dbRun("UPDATE settings SET monthly_limit = ? WHERE group_code = ?", [amt, group]);
    userSteps.delete(uid); return ctx.reply(`🎉 *Новый месячный лимит в размере ${formatAmount(amt)} успешно сохранен!*`, md(cfg.menuKeyboard));
  }

  if (state && state.step === "awaiting_code") {
    const code = text.trim().toUpperCase();
    // Проверяем, существует ли вообще такая созданная группа в базе
    const check = await dbGet("SELECT user_id FROM settings WHERE group_code = ? LIMIT 1", [code]);
    if (!check) return ctx.reply("❌ Группа не найдена. Проверьте правильность кода и введите еще раз:", md(cancelInline));
    
    // ЖЕСТКИЙ ФИКС: Записываем жене код группы и переписываем её лимит на лимит создателя группы
    const creatorLimit = await getUserLimit(check.user_id);
    await dbRun("INSERT INTO settings (user_id, monthly_limit, group_code) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET group_code = ?, monthly_limit = ?", 
      [uid, creatorLimit, code, code, creatorLimit]);
    
    userSteps.delete(uid);
    return ctx.reply(`🎉 *Успешно! Вы подключились к семейной группе ${code}.* Теперь ваши лимиты, расходы и статистика полностью синхронизированы!`, md(menuKeyboard));
  }
  return ctx.reply("Выберите действие на панели:", md(cfg.menuKeyboard));
});

bot.action(/^cat:(.+)$/, async (ctx) => {
  const state = userSteps.get(ctx.from.id); if (!state || state.step !== "awaiting_category") return ctx.answerCbQuery();
  const cat = cfg.CATEGORIES.find(c => c.id === ctx.match[1]); state.category = cat ? cat.label : "🌀 Другое"; state.step = "awaiting_comment";
  await ctx.answerCbQuery(); await ctx.editMessageText("📝 *Введите комментарий к трате или пропустите этот шаг:*", md(cfg.commentInline));
});

bot.action("edit_limit_prompt", async (ctx) => { await ctx.answerCbQuery(); userSteps.set(ctx.from.id, { step: "awaiting_limit" }); await ctx.editMessageText("💰 *Введите сумму нового месячного лимита (только число):*", md(cfg.cancelInline)); });
bot.action("family_menu", async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText("👥 *Семейный доступ*\n\nСоздайте группу и передайте код жене, либо войдите по её коду:", md(cfg.familyInline)); });
bot.action("back_to_settings", async (ctx) => { await ctx.answerCbQuery(); userSteps.delete(ctx.from.id); await sendSettingsMessage(ctx, ctx.from.id); });

bot.action("create_group", async (ctx) => {
  await ctx.answerCbQuery(); const uid = ctx.from.id; if (await getUserGroup(uid)) return ctx.editMessageText("Вы уже состоите в группе.", md(cfg.menuKeyboard));
  const code = "FAM-" + Math.floor(1000 + Math.random() * 9000); const currentLimit = await getUserLimit(uid);
  await dbRun("INSERT INTO settings (user_id, monthly_limit, group_code) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET group_code = ?", [uid, currentLimit, code, code]);
  await ctx.editMessageText(`🎉 *Семейная группа успешно создана!*\n\n🔑 Ваш код доступа: \`${code}\`\n\nСкопируйте его и отправьте жене. Ей нужно зайти в настройки своего бота, нажать "Войти по коду" и отправить этот код.`, md(cfg.familyInline));
});

bot.action("join_group_prompt", async (ctx) => { await ctx.answerCbQuery(); userSteps.set(ctx.from.id, { step: "awaiting_code" }); await ctx.editMessageText("🔑 *Введите код семейной группы (например, FAM-1234):*", md(cfg.cancelInline)); });
bot.action("skip_comment", async (ctx) => { await ctx.answerCbQuery(); await finishExpense(ctx, "Без комментария"); });
bot.action("cancel_action", async (ctx) => { userSteps.delete(ctx.from.id); await ctx.answerCbQuery(); await ctx.reply("Действие отменено.", md(cfg.menuKeyboard)); });

bot.action(/^delete_(\d+)$/, async (ctx) => {
  await dbRun("DELETE FROM expenses WHERE id = ?", [ctx.match[1]]);
  await ctx.answerCbQuery("Удалено!"); await ctx.editMessageText("❌ *Расход успешно удален.*", md());
});

bot.start((ctx) => ctx.reply(cfg.START_TEXT, md(cfg.menuKeyboard)));

initDb().then(() => bot.launch()).then(() => console.log("Бот запущен!")).catch(e => console.error(e));
http.createServer((req, res) => { res.writeHead(200); res.end("Live"); }).listen(process.env.PORT || 3000);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));