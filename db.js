const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database(path.join(__dirname, "expenses.db"));
const cfg = require("./config");

function dbRun(sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));
}
function dbAll(sql, params = []) {
  return new Promise((res, rej) => db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); }));
}
function dbGet(sql, params = []) {
  return new Promise((res, rej) => db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); }));
}

function initDb() {
  return Promise.all([
    dbRun("CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount REAL, category TEXT, comment TEXT, user_name TEXT, date TEXT)"),
    dbRun("CREATE TABLE IF NOT EXISTS settings (user_id INTEGER PRIMARY KEY, monthly_limit REAL, group_code TEXT)")
  ]);
}

async function getUserGroup(userId) {
  const row = await dbGet("SELECT group_code FROM settings WHERE user_id = ?", [userId]);
  return row ? row.group_code : null;
}
async function getUserLimit(userId) {
  const group = await getUserGroup(userId);
  if (group) {
    const row = await dbGet("SELECT monthly_limit FROM settings WHERE group_code = ? ORDER BY user_id ASC LIMIT 1", [group]);
    return row && row.monthly_limit ? row.monthly_limit : cfg.DEFAULT_LIMIT;
  }
  const row = await dbGet("SELECT monthly_limit FROM settings WHERE user_id = ?", [userId]);
  return row && row.monthly_limit ? row.monthly_limit : cfg.DEFAULT_LIMIT;
}
async function saveUserLimit(userId, limit) {
  const group = await getUserGroup(userId);
  await dbRun("INSERT INTO settings (user_id, monthly_limit) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_limit = ?", [userId, limit, limit]);
  if (group) await dbRun("UPDATE settings SET monthly_limit = ? WHERE group_code = ?", [limit, group]);
}
function saveExpense({ userId, userName, amount, category, comment }) {
  return dbRun("INSERT INTO expenses (user_id, amount, category, comment, user_name, date) VALUES (?, ?, ?, ?, ?, ?)", [userId, amount, category, comment, userName, new Date().toISOString()]);
}
async function getGroupOrUserExpenses(userId, fromIso) {
  const group = await getUserGroup(userId);
  if (group) {
    const members = await dbAll("SELECT user_id FROM settings WHERE group_code = ?", [group]);
    const memberIds = members.map(m => m.user_id).join(",");
    return dbAll(`SELECT amount, category FROM expenses WHERE user_id IN (${memberIds}) AND date >= ?`, [fromIso]);
  }
  return dbAll("SELECT amount, category FROM expenses WHERE user_id = ? AND date >= ?", [userId, fromIso]);
}
async function getRecentExpenses(userId) {
  const group = await getUserGroup(userId);
  if (group) {
    const members = await dbAll("SELECT user_id FROM settings WHERE group_code = ?", [group]);
    const memberIds = members.map(m => m.user_id).join(",");
    return dbAll(`SELECT id, amount, category, comment, user_name, date FROM expenses WHERE user_id IN (${memberIds}) ORDER BY id DESC LIMIT 5`);
  }
  return dbAll("SELECT id, amount, category, comment, user_name, date FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 5", [userId]);
}

function formatAmount(amount) {
  const [intPart, fracPart] = Number(amount).toFixed(2).split(".");
  const withSpaces = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return fracPart === "00" ? `${withSpaces} ₽` : `${withSpaces},${fracPart} ₽`;
}
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

module.exports = { initDb, getUserGroup, getUserLimit, saveUserLimit, saveExpense, getGroupOrUserExpenses, getRecentExpenses, dbRun, dbGet, formatAmount, formatDate };
