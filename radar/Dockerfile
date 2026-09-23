FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# Dependencies come from pyproject.toml, the one list of them, so the image
# cannot drift from what the tests ran against.
COPY pyproject.toml ./
COPY radar ./radar
RUN pip install --no-cache-dir .
COPY web ./web

# Nothing here needs root, and a public-facing process should not have it.
RUN useradd --system --no-create-home --uid 10001 radar
USER radar

# The model is not in this image. It stays on the machine with the GPU and is
# reached over LAYA_ENDPOINT, so this container is small and stateless.
ENV LAYA_ENDPOINT=http://172.17.0.1:8919
EXPOSE 8777

# /healthz turns 503 once no transfer has arrived for two minutes; /api/stats
# answers either way, so pointing here at it hid a dead feed indefinitely.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8777/healthz',timeout=4)" || exit 1

# The only thing a viewer ever sends is one short question; capping frames at
# 4 KiB keeps anyone from making the server buffer the default 16 MiB.
CMD ["uvicorn", "radar.server:app", "--host", "0.0.0.0", "--port", "8777", "--ws-max-size", "4096"]
