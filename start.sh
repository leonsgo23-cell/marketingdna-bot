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

wait -n 2>/dev/null || wait
echo "One service exited, stopping all..."
kill $BOT1_PID $BOT2_PID $BOT3_PID $VISUAL_PID 2>/dev/null
exit 1
