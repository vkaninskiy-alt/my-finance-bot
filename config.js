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
const START_TEXT = "👋 *Добро пожаловать в Семейный бюджет!*\n\nЗдесь можно записывать расходы, следить за лимитами и сравнивать личные траты с семейными.\n\n👇 Выбери действие в меню. Начни с кнопки «➕ Добавить расход».";

const menuKeyboard = Markup.keyboard([
  ["➕ Добавить расход"],
  ["📊 Статистика", "📜 История"],
  ["👥 Семья", "⚙️ Настройки"]
]).resize();

const cancelInline = Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", "cancel_action")]]);
const commentInline = Markup.inlineKeyboard([
  [Markup.button.callback("⏭ Пропустить", "skip_comment")],
  [Markup.button.callback("❌ Отмена", "cancel_action")]
]);
const settingsInline = Markup.inlineKeyboard([
  [Markup.button.callback("💰 Личный лимит", "edit_limit_prompt")],
  [Markup.button.callback("👥 Семейный доступ", "family_menu")]
]);
const familyInline = Markup.inlineKeyboard([
  [Markup.button.callback("➕ Создать группу", "create_group")],
  [Markup.button.callback("🔗 Войти по коду", "join_group_prompt")],
  [Markup.button.callback("⬅️ В настройки", "back_to_settings")]
]);

module.exports = {
  CATEGORIES, DIVIDER, DEFAULT_LIMIT, START_TEXT,
  menuKeyboard, cancelInline, commentInline, settingsInline, familyInline
};
