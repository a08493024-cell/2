import os
import time
import logging
import requests
from bs4 import BeautifulSoup
from apscheduler.schedulers.background import BackgroundScheduler
from telegram import Bot, Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
from telegram.constants import ParseMode
import asyncio

# --- НАСТРОЙКИ ---
# Токен и ID чата берем из переменных окружения (безопасно)
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "ВАШ_ТОКЕН")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "ВАШ_ID_ЧАТА")

# Список исключений (габаритное, тяжелое и т.д.)
EXCLUDED_KEYWORDS = [
    "шланг", "теплица", "лестница", "бетономешалка", "качели", "ванна", "дверь", 
    "радиатор", "лист", "труба", "кабель", "бухта", "цемент", "плитка", "кирпич", 
    "смесь", "баллон", "сверло", "бита", "крепеж", "перчатки", "изолента", 
    "спецодежда", "обувь", "шкаф", "диван", "кровать", "станок", "дрова", "сетка"
]

# Память для антидублей (последние 6 товаров)
sent_history = []

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- ЛОГИКА ПАРСИНГА ---
def parse_vseinstrumenti(retry=False):
    url = "https://www.vseinstrumenti.ru/sale/"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        
        products = []
        # Ищем карточки товаров. Селекторы могут меняться, проверяйте data-testid
        cards = soup.find_all(attrs={"data-testid": "product-card"})
        
        for card in cards:
            try:
                name_el = card.find(attrs={"data-testid": "product-name"})
                name = name_el.text.strip()
                link = "https://www.vseinstrumenti.ru" + card.find("a")["href"]
                
                # Цены
                curr_price_text = card.find(attrs={"data-testid": "product-price-current"}).text
                old_price_text = card.find(attrs={"data-testid": "product-price-old"}).text
                
                curr_price = int(''.join(filter(str.isdigit, curr_price_text)))
                old_price = int(''.join(filter(str.isdigit, old_price_text)))
                
                discount = round(((old_price - curr_price) / old_price) * 100)
                
                # ФИЛЬТРЫ
                if not (1500 <= curr_price <= 20000): continue
                if discount <= 50: continue
                
                lower_name = name.lower()
                if any(word in lower_name for word in EXCLUDED_KEYWORDS): continue
                
                products.append({
                    "id": link.split("/")[-1] or name,
                    "name": name,
                    "curr": curr_price,
                    "old": old_price,
                    "disc": discount,
                    "link": link
                })
            except Exception:
                continue
                
        return products
    except Exception as e:
        print(f"Ошибка парсинга: {e}")
        if not retry:
            time.sleep(5)
            return parse_vseinstrumenti(retry=True)
        return None

# --- ОТПРАВКА ---
async def check_and_send(bot_instance):
    global sent_history
    print("Начинаю проверку акций...")
    
    products = parse_vseinstrumenti()
    
    if products is None:
        await bot_instance.send_message(CHAT_ID, "⚠️ Ошибка при парсинге сайта. Бот сделал 2 попытки.")
        return

    if not products:
        await bot_instance.send_message(CHAT_ID, "Сегодня скидок не найдено")
        return

    # Сортировка по скидке
    products.sort(key=lambda x: x['disc'], reverse=True)
    top_products = products[:20]
    
    found_new = False
    for p in top_products:
        if p['id'] in sent_history: continue
        
        msg = (
            f"<b>Раздел: Акции</b>\n"
            f"{p['name']}\n"
            f"Старая цена: {p['old']}\n"
            f"Новая цена: {p['curr']}\n"
            f"Скидка: {p['disc']}%\n"
            f"{p['link']}"
        )
        
        await bot_instance.send_message(CHAT_ID, msg, parse_mode=ParseMode.HTML)
        
        sent_history.append(p['id'])
        if len(sent_history) > 6: sent_history.pop(0)
        found_new = True
        await asyncio.sleep(0.5)

    if not found_new:
        print("Новых товаров нет.")

# --- КОМАНДЫ ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Бот запущен. Команда /check - ручная проверка.")

async def check_manual(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Запускаю ручную проверку...")
    await check_and_send(context.bot)

# --- МАГИЯ ЗАПУСКА ---
if __name__ == '__main__':
    # Создаем бота
    app = ApplicationBuilder().token(TOKEN).build()
    
    # Добавляем команды
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("check", check_manual))

    # Планировщик
    scheduler = BackgroundScheduler()
    # Запуск каждый день в 11:00
    scheduler.add_job(lambda: asyncio.run(check_and_send(app.bot)), 'cron', hour=11, minute=0)
    scheduler.start()

    print("Бот запущен и ждет 11:00...")
    app.run_polling()
