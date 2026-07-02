#!/bin/bash

# Защита от случайного запуска на локальном компьютере
if [ -z "$RAILWAY_PROJECT_ID" ]; then
  echo "❌ Нельзя запускать локально — боты работают на Railway."
  echo "   Чтобы задеплоить изменения: git push"
  exit 1
fi

echo "Starting Bot #1 (admin)..."
node index.js &
BOT1_PID=$!

echo "Starting Bot #2 (client)..."
node bot2.js &
BOT2_PID=$!

echo "Starting Bot #3 (manager review)..."
node bot3.js &
BOT3_PID=$!

echo "Starting Visual Service..."
node visual.js &
VISUAL_PID=$!

# Bot4 запускается только если задан токен
BOT4_PID=""
if [ -n "$TELEGRAM_BOT4_TOKEN" ]; then
  echo "Starting Bot #4 (final review)..."
  node bot4.js &
  BOT4_PID=$!
fi

# Bot5 (Продюсер) запускается только если задан токен
BOT5_PID=""
if [ -n "$TELEGRAM_BOT5_TOKEN" ]; then
  echo "Starting Bot #5 (producer)..."
  node producer.js &
  BOT5_PID=$!
fi

echo "All services running. Bot1=$BOT1_PID Bot2=$BOT2_PID Bot3=$BOT3_PID Visual=$VISUAL_PID Bot4=${BOT4_PID:-none} Bot5=${BOT5_PID:-none}"

# Ждём только Bot1/Bot2/Bot3 — если они упали, всё плохо
wait $BOT1_PID $BOT2_PID $BOT3_PID
echo "Core service exited, stopping all..."
kill $VISUAL_PID 2>/dev/null
[ -n "$BOT4_PID" ] && kill $BOT4_PID 2>/dev/null
[ -n "$BOT5_PID" ] && kill $BOT5_PID 2>/dev/null
exit 1
