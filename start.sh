#!/bin/bash
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

echo "All services running. Bot1=$BOT1_PID Bot2=$BOT2_PID Bot3=$BOT3_PID Visual=$VISUAL_PID"

# Ждём только Bot1/Bot2/Bot3 — если они упали, всё плохо
# Visual.js может падать и перезапускаться независимо
wait $BOT1_PID $BOT2_PID $BOT3_PID
echo "Core service exited, stopping all..."
kill $VISUAL_PID 2>/dev/null
exit 1
