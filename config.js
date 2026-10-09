"use strict";

const { Markup } = require("telegraf");

const CATEGORIES = [
  { id: "supermarket", label: "🛒 Супермаркеты" },
  { id: "cafe", label: "🍔 Кафе и рестораны" },
  { id: "transport", label: "🚗 Транспорт и авто" },
  { id: "housing", label: "🏠 Жилье и ЖКХ" },
  { id: "health", label: "💊 Здоровье и аптеки" },
  { id: "shopping", label: "🛍 Одежда и шопинг" },
  { id: "comms", label: "📱 Связь и интернет" },
  { id: "other", label: "🌀 Иные расходы" }
];

const DIVIDER = "──────────────────";
const DEFAULT_LIMIT = 50000;
const START_TEXT = "👋 *Привет! Я твой семейный финансовый ассистент.*\n\nЯ помогу вам контролировать бюджет и анализировать траты.\nВы можете объединиться с партнёром в настройках для совместного учета!";

const menuKeyboard = Markup.keyboard([
  ["➕ Добавить расход"],
  ["📊 Статистика", "📜 История и удаление", "⚙️ Настройки"]
]).resize();

const cancelInline = Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "cancel_action")]]);
const commentInline = Markup.inlineKeyboard([
  [Markup.button.callback("⏭ Пропустить", "skip_comment")],
  [Markup.button.callback("❌ Отмена", "cancel_action")]
]);
const settingsInline = Markup.inlineKeyboard([
  [Markup.button.callback("💰 Изменить лимит бюджета", "edit_limit_prompt")],
  [Markup.button.callback("👥 Семейный доступ", "family_menu")]
]);
const familyInline = Markup.inlineKeyboard([
  [Markup.button.callback("➕ Создать группу", "create_group")],
  [Markup.button.callback("🔗 Войти по коду", "join_group_prompt")],
  [Markup.button.callback("⬅️ Назад в Настройки", "back_to_settings")]
]);

module.exports = {
  CATEGORIES, DIVIDER, DEFAULT_LIMIT, START_TEXT,
  menuKeyboard, cancelInline, commentInline, settingsInline, familyInline
};
