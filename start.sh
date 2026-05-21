#!/bin/bash
echo "Starting Bot #1 (admin)..."
node index.js &
BOT1_PID=$!

echo "Starting Bot #2 (client)..."
node bot2.js &
BOT2_PID=$!

echo "Both bots running. Bot1 PID=$BOT1_PID, Bot2 PID=$BOT2_PID"

# Wait for either to exit, then stop both
wait -n 2>/dev/null || wait
echo "One bot exited, stopping both..."
kill $BOT1_PID $BOT2_PID 2>/dev/null
exit 1
