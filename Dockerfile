FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10001 --create-home management

COPY portal/ ./portal/
COPY management/ ./management/
COPY static/ ./static/

RUN mkdir -p /var/log/portal /var/log/management \
    && chown -R management:management /app /var/log/portal /var/log/management

USER management

EXPOSE 8001

CMD ["uvicorn", "management.web:create_app", "--factory", "--host", "0.0.0.0", "--port", "8001", "--no-access-log", "--no-proxy-headers"]
