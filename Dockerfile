# syntax=docker/dockerfile:1
FROM node:22-slim AS web-builder
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY contracts/ /build/contracts/
COPY web/ ./
RUN npm run build

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    WEB_DIST_DIR=/app/web/dist \
    PYTHONPATH=/app/api:/app/cad:/app/bridge:/app/contracts/generated/python

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libxrender1 \
    libxext6 \
    libsm6 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r /app/api/requirements.txt

COPY contracts/ /app/contracts/
COPY api/ /app/api/
COPY cad/ /app/cad/
COPY bridge/ /app/bridge/

RUN if [ -f /app/cad/requirements.txt ]; then pip install --no-cache-dir -r /app/cad/requirements.txt; fi \
    && if [ -f /app/bridge/requirements.txt ]; then pip install --no-cache-dir -r /app/bridge/requirements.txt; fi \
    && pip install --no-cache-dir --no-deps -e /app

COPY --from=web-builder /build/web/dist /app/web/dist

EXPOSE 8080

CMD ["sh", "-c", "uvicorn stratum_api.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
