FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY watchdog.py .
CMD ["python", "-u", "watchdog.py"]
