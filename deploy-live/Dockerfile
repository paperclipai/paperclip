FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY real_trader.py dashboard.py start.sh heartbeat.sh ./
RUN chmod +x start.sh heartbeat.sh

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

EXPOSE 8080

CMD ["./start.sh"]
