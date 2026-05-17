import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Telegraf } from "telegraf";
import axios from "axios";
import * as cheerio from "cheerio";
import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();

/**
 * КОНФИГУРАЦИЯ БОТА
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const bot = new Telegraf(TOKEN);

// Список слов-исключений для фильтрации (габаритные и мелкие товары)
const EXCLUDED_KEYWORDS = [
  "шланг", "теплица", "лестница", "бетономешалка", "качели", "ванна", "дверь", 
  "радиатор", "лист", "труба", "кабель", "бухта", "цемент", "плитка", "кирпич", 
  "смесь", "баллон", "сверло", "бита", "крепеж", "перчатки", "изолента", 
  "спецодежда", "обувь", "шкаф", "диван", "кровать", "станок", "дрова", "сетка"
];

// Память для антидублей (храним последние 6 ID товаров)
let sentProductIds: string[] = [];

/**
 * ФУНКЦИЯ ПАРСИНГА
 */
async function fetchDiscounts(retry = false): Promise<any[]> {
  try {
    const url = "https://www.vseinstrumenti.ru/sale/";
    // Используем заголовки, чтобы сайт не принял нас за робота
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const products: any[] = [];

    // Селекторы могут меняться со временем, это основная часть для контроля
    // Находим карточки товаров на странице акций
    $("[data-testid='product-card']").each((i, el) => {
      const name = $(el).find("[data-testid='product-name']").text().trim();
      const link = "https://www.vseinstrumenti.ru" + $(el).find("a").attr("href");
      
      // Цены
      const currentPriceText = $(el).find("[data-testid='product-price-current']").text().replace(/[^0-9]/g, "");
      const oldPriceText = $(el).find("[data-testid='product-price-old']").text().replace(/[^0-9]/g, "");
      
      const currentPrice = parseInt(currentPriceText);
      const oldPrice = parseInt(oldPriceText);

      if (!name || isNaN(currentPrice) || isNaN(oldPrice)) return;

      // Считаем скидку
      const discount = Math.round(((oldPrice - currentPrice) / oldPrice) * 100);

      // 1. Фильтрация по цене: 1500 - 20000 руб
      if (currentPrice < 1500 || currentPrice > 20000) return;

      // 2. Фильтрация по скидке: строго больше 50%
      if (discount <= 50) return;

      // 3. Исключение по ключевым словам
      const lowerName = name.toLowerCase();
      const isExcluded = EXCLUDED_KEYWORDS.some(word => lowerName.includes(word));
      if (isExcluded) return;

      products.push({
        id: link.split("/").pop() || name,
        name,
        currentPrice,
        oldPrice,
        discount,
        link
      });
    });

    return products;
  } catch (error) {
    console.error("Ошибка парсинга:", error);
    if (!retry) {
      console.log("Пробуем еще раз...");
      return fetchDiscounts(true);
    }
    throw error;
  }
}

/**
 * ЛОГИКА ПРОВЕРКИ И ОТПРАВКИ
 */
async function checkAndSend() {
  try {
    const products = await fetchDiscounts();

    if (products.length === 0) {
      if (CHAT_ID) await bot.telegram.sendMessage(CHAT_ID, "Сегодня выгодных скидок (>50%) не найдено.");
      return;
    }

    // Сортировка по максимальной скидке
    products.sort((a, b) => b.discount - a.discount);

    // Берем ТОР-20
    const top20 = products.slice(0, 20);
    
    let sentCount = 0;
    for (const p of top20) {
      // Антидубль: проверяем, не отправляли ли мы это недавно
      if (sentProductIds.includes(p.id)) continue;

      const message = `
<b>Раздел: Акции</b>
📦 <b>${p.name}</b>
❌ Старая цена: ${p.oldPrice} ₽
✅ Новая цена: <b>${p.currentPrice} ₽</b>
🔥 Скидка: <b>${p.discount}%</b>

🔗 <a href="${p.link}">Купить на сайте</a>
      `;

      await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: "HTML" });
      
      // Добавляем в историю (максимум 6 последних)
      sentProductIds.push(p.id);
      if (sentProductIds.length > 6) sentProductIds.shift();
      
      sentCount++;
      // Небольшая задержка, чтобы Telegram не забанил за спам
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (sentCount === 0) {
      console.log("Все найденные товары уже были отправлены ранее.");
    }

  } catch (error) {
    console.error("Критическая ошибка:", error);
    if (CHAT_ID) {
      await bot.telegram.sendMessage(CHAT_ID, "⚠️ Ошибка при парсинге сайта. Бот сделал 2 попытки и не смог получить данные.");
    }
  }
}

/**
 * ОБРАБОТКА КОМАНД TELEGRAM
 */
bot.command("start", (ctx) => {
  ctx.reply("Привет! Я слежу за скидками на VseInstrumenti.ru.\n\nКоманда /check — ручная проверка.");
});

bot.command("check", async (ctx) => {
  await ctx.reply("Начинаю проверку... Это может занять несколько секунд.");
  await checkAndSend();
});

/**
 * ПЛАНИРОВЩИК (Cron)
 * Запуск каждый день в 11:00 (по времени сервера)
 */
cron.schedule("0 11 * * *", () => {
  console.log("Запуск ежедневной проверки...");
  checkAndSend();
});

/**
 * ЗАПУСК EXPRESS И БОТА
 */
async function startServer() {
  const app = express();
  const PORT = 3000;

  // Веб-интерфейс (просто статус)
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      bot: TOKEN ? "running" : "missing_token",
      chatId: CHAT_ID ? "set" : "missing"
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    
    if (TOKEN) {
      bot.launch();
      console.log("Бот успешно запущен!");
    } else {
      console.error("ОШИБКА: Токен Telegram не задан в переменных окружения!");
    }
  });
}

startServer();

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
