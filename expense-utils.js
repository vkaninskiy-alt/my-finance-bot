"use strict";

const MAX_AMOUNT = 1_000_000_000;

function parseAmount(value) {
  const normalized = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 && amount <= MAX_AMOUNT ? amount : null;
}

function detectCategory(text, categories) {
  const value = String(text || "").toLowerCase();
  const rules = [
    ["supermarket", /продукт|магазин|супермаркет|еда|хлеб|молок|lidl|rimi|maxima|selver|алко/],
    ["cafe", /кафе|ресторан|обед|ужин|завтрак|доставка|пицц|бургер|кофе/],
    ["transport", /такси|топлив|бензин|заправ|автобус|трамвай|транспорт|парковк/],
    ["housing", /аренд|жкх|коммунал|электр|вода|отоплен/],
    ["health", /аптек|лекар|врач|здоров|стоматолог/],
    ["shopping", /одежд|обув|покупк|шопинг/],
    ["comms", /телефон|мобильн|связь|интернет|подписк/]
  ];
  const id = rules.find(([, pattern]) => pattern.test(value))?.[0] || "other";
  return categories.find((item) => item.id === id) || categories[categories.length - 1];
}

function quickExpenseParts(text, categories) {
  const match = String(text || "").trim().match(/^(\d+(?:[.,]\d{1,2})?)\s+(.+)$/);
  if (!match) return null;
  const amount = parseAmount(match[1]);
  const description = match[2].trim();
  if (amount === null || !description) return null;
  return { amount, description, category: detectCategory(description, categories) };
}

module.exports = { parseAmount, detectCategory, quickExpenseParts };
