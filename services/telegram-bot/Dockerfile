FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py .

EXPOSE 8000
CMD ["uvicorn", "bot:api", "--host", "0.0.0.0", "--port", "8000"]
