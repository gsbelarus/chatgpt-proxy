# chatgpt-proxy

A lightweight HTTP proxy server for OpenAI APIs. It wraps the official OpenAI SDK and exposes simplified endpoints for chat completions, audio transcriptions, and embeddings with built-in authentication, logging, and metrics.

## Features

- **Chat Completions** — Full OpenAI Chat Completions API support including vision (images)
- **Audio Transcriptions** — Whisper-based speech-to-text
- **Embeddings** — Generate text embeddings
- **Simple Chat** — Simplified `/chatgpt` endpoint for quick prompts
- **Health Checks** — Built-in health endpoints
- **Logging & Metrics** — Request/response logs, token usage stats, error tracking
- **CORS** — Enabled for all origins

---

## Installation

```bash
npm install
```

## Configuration

Create a `.env` or `.env.local` file in the project root:

```env
OPENAI_API_KEY=sk-...
OPENAI_PROJECT_KEY=proj_...      # Optional
SECURITY_KEY=your-secret-key     # Required for authenticated endpoints
```

## Running

**Development (with hot reload):**

```bash
npm run local:watch
```

**Production:**

```bash
npm run start
```

The server starts on **http://localhost:3002** by default.

---

## API Endpoints

### `GET /`

Returns a simple HTML page to verify the server is running.

---

### `POST /openai`

**Main endpoint for OpenAI Chat Completions API.**

Proxies requests to `POST https://api.openai.com/v1/chat/completions`.

#### Request Body (JSON)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `openai_api_key` | string | ❌ | Override the default API key |
| `project` | string | ❌ | OpenAI project ID |
| `organization` | string | ❌ | OpenAI organization ID |
| `image` | object | ❌ | Image for vision models (see below) |
| `model` | string | ✅ | Model ID (e.g., `gpt-4o`, `gpt-4o-mini`) |
| `messages` | array | ✅ | Array of message objects |
| `temperature` | number | ❌ | Sampling temperature (0-2) |
| `top_p` | number | ❌ | Nucleus sampling (0-1) |
| `max_tokens` | number | ❌ | Max tokens to generate |
| `max_completion_tokens` | number | ❌ | Max completion tokens |
| ... | ... | ❌ | Any other Chat Completions API parameters |

> **Note:** `stream: true` is not supported on this endpoint.

#### Image Object

```json
{
  "url": "https://example.com/image.png"
}
```

or

```json
{
  "base64": "iVBORw0KGgoAAAANSUhEUg..."
}
```

#### Example Request

```bash
curl -X POST http://localhost:3002/openai \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is TypeScript?"}
    ],
    "temperature": 0.7,
    "max_tokens": 500
  }'
```

#### Example with Image (Vision)

```bash
curl -X POST http://localhost:3002/openai \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "messages": [
      {"role": "user", "content": "What is in this image?"}
    ],
    "image": {
      "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Camponotus_flavomarginatus_ant.jpg/800px-Camponotus_flavomarginatus_ant.jpg"
    }
  }'
```

#### Response

Standard OpenAI Chat Completion response:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "TypeScript is..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 100,
    "total_tokens": 125
  }
}
```

---

### `POST /chatgpt`

**Simplified chat endpoint** using the `chatgpt` library.

#### Request Body (JSON)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `prompt` | string | ✅ | The user message |
| `model` | string | ❌ | Model ID (default: `gpt-4o-mini`) |
| `temperature` | number | ❌ | Sampling temperature (0-2) |
| `top_p` | number | ❌ | Nucleus sampling (0-1) |
| `max_tokens` | number | ❌ | Max tokens to generate |
| `max_completion_tokens` | number | ❌ | Max completion tokens |

#### Example Request

```bash
curl -X POST http://localhost:3002/chatgpt \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "prompt": "Explain quantum computing in simple terms",
    "model": "gpt-4o-mini",
    "temperature": 0.8
  }'
```

---

### `POST /openai/audio/transcriptions`

**Audio transcription** using OpenAI Whisper.

#### Request (multipart/form-data)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | ✅ | Audio file (wav, mp3, m4a, etc.) |
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `openai_api_key` | string | ❌ | Override the default API key |
| `project` | string | ❌ | OpenAI project ID |
| `organization` | string | ❌ | OpenAI organization ID |
| `model` | string | ❌ | Model ID (default: `whisper-1`) |
| `language` | string | ❌ | Language code (e.g., `en`, `es`) |
| `prompt` | string | ❌ | Optional prompt to guide transcription |
| `temperature` | number | ❌ | Sampling temperature (default: 0) |
| `response_format` | string | ❌ | `json`, `text`, `srt`, `verbose_json`, `vtt` |
| `timestamp_granularities[]` | string | ❌ | `word` and/or `segment` |

#### Example Request

```bash
curl -X POST http://localhost:3002/openai/audio/transcriptions \
  -F "file=@audio.mp3" \
  -F "security_key=your-secret-key" \
  -F "model=whisper-1" \
  -F "language=en" \
  -F "response_format=json"
```

#### Response

```json
{
  "text": "Hello, this is a transcription of the audio file."
}
```

---

### `POST /embeddings`

**Generate text embeddings.**

#### Request Body (JSON)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `input` | string or array | ✅ | Text(s) to embed |
| `model` | string | ❌ | Model ID (default: `text-embedding-3-large`) |
| `dimensions` | number | ❌ | Output dimensions |
| `encoding_format` | string | ❌ | `float` or `base64` |

#### Example Request

```bash
curl -X POST http://localhost:3002/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "input": "The quick brown fox jumps over the lazy dog",
    "model": "text-embedding-3-small",
    "dimensions": 512
  }'
```

#### Response

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0023064255, -0.009327292, ...]
    }
  ],
  "model": "text-embedding-3-small",
  "usage": {
    "prompt_tokens": 9,
    "total_tokens": 9
  }
}
```

---

## Error Responses

| Status | Description |
|--------|-------------|
| `400` | Bad Request — Invalid input or streaming not supported |
| `403` | Forbidden — Invalid or missing `security_key` |
| `404` | Not Found — Unknown endpoint |
| `429` | Too Many Requests — Rate limit exceeded (health/log endpoints) |
| `500` | Internal Server Error — OpenAI API error or server issue |

---

## Docker

Build and push Docker image:

```bash
npm run docker
```

Or manually:

```bash
docker build -t chatgpt-proxy .
docker run -p 3002:3002 --env-file .env chatgpt-proxy
```

---

## Server Configuration

- **Port:** 3002
- **Request Timeout:** 15 minutes (900,000 ms)
- **Keep-Alive Timeout:** 15 minutes
- **Headers Timeout:** ~16 minutes

---

## License

ISC