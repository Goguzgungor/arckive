FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn[standard]>=0.30" "httpx>=0.27" "websockets>=13"

COPY radar ./radar
COPY web ./web

# The model is not in this image. It stays on the machine with the GPU and is
# reached over LAYA_ENDPOINT, so this container is small and stateless.
ENV LAYA_ENDPOINT=http://172.17.0.1:8919
EXPOSE 8777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8777/api/stats',timeout=4)" || exit 1

CMD ["uvicorn", "radar.server:app", "--host", "0.0.0.0", "--port", "8777"]
