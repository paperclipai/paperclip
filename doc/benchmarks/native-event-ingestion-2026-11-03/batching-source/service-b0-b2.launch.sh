#!/bin/bash
set -u
cd /home/ubuntu/native-ingestion/fixture2-cursors
date -Is > /home/ubuntu/native-ingestion/evidence/fixture2/interleaved-service/qualification/service-b0-b2.started
node /home/ubuntu/native-ingestion/helpers/native-ingestion-run-interleaved-service.mjs --execute --stage=service-b0-b2 --root=/home/ubuntu/native-ingestion/fixture2-cursors --harness-root=/home/ubuntu/native-ingestion/harness-v3 --b0-root=/home/ubuntu/native-ingestion/fixture2-baseline --b2-root=/home/ubuntu/native-ingestion/fixture2-batching --output-root=/home/ubuntu/native-ingestion/evidence/fixture2/interleaved-service > /home/ubuntu/native-ingestion/evidence/fixture2/interleaved-service/qualification/service-b0-b2.log 2>&1
code=$?
printf '%s\n' "$code" > /home/ubuntu/native-ingestion/evidence/fixture2/interleaved-service/qualification/service-b0-b2.exit
exit "$code"
