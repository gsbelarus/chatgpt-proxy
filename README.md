# chatgpt-proxy

A lightweight HTTP proxy server for OpenAI APIs. It wraps the official OpenAI SDK and exposes simplified endpoints for chat completions, audio transcriptions, and embeddings with built-in authentication, logging, and metrics.

## Features

- **Responses API** — OpenAI's most advanced interface with tools, web search, file search, MCP, function calling, and streaming
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

### `POST /openai2`

**OpenAI Responses API endpoint** — The most advanced interface for generating model responses with support for tools, files, web searching, MCP, function calling, and more.

Proxies requests to `POST https://api.openai.com/v1/responses`.

#### Request Body (JSON)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `openai_api_key` | string | ❌ | Override the default API key |
| `project` | string | ❌ | OpenAI project ID |
| `organization` | string | ❌ | OpenAI organization ID |
| `model` | string | ✅ | Model ID (e.g., `gpt-4o`, `gpt-4.1`, `o3`) |
| `input` | string/array | ✅ | Text, image, or file inputs to the model |
| `instructions` | string | ❌ | System/developer message inserted into context |
| `tools` | array | ❌ | Array of tools (web_search, file_search, function, mcp, etc.) |
| `tool_choice` | string/object | ❌ | How model should select tools (`auto`, `none`, `required`, or specific tool) |
| `stream` | boolean | ❌ | Enable Server-Sent Events streaming (default: `false`) |
| `temperature` | number | ❌ | Sampling temperature (0-2, default: 1) |
| `top_p` | number | ❌ | Nucleus sampling (0-1, default: 1) |
| `max_output_tokens` | integer | ❌ | Max tokens for response including reasoning |
| `max_tool_calls` | integer | ❌ | Max total calls to built-in tools |
| `parallel_tool_calls` | boolean | ❌ | Allow parallel tool calls (default: `true`) |
| `previous_response_id` | string | ❌ | ID of previous response for multi-turn conversations |
| `conversation` | string/object | ❌ | Conversation context (cannot use with `previous_response_id`) |
| `store` | boolean | ❌ | Store response for later retrieval (default: `true`) |
| `metadata` | object | ❌ | Up to 16 key-value pairs for additional info |
| `include` | array | ❌ | Additional output data to include (see below) |
| `text` | object | ❌ | Text response configuration (format, structured output) |
| `reasoning` | object | ❌ | Reasoning model configuration (effort, summary) |
| `truncation` | string | ❌ | Truncation strategy (`auto` or `disabled`) |
| `background` | boolean | ❌ | Run response in background (default: `false`) |
| `service_tier` | string | ❌ | Processing tier (`auto`, `default`, `flex`, `priority`) |

#### Include Options

Specify additional output data to include:
- `web_search_call.action.sources` — Include web search sources
- `code_interpreter_call.outputs` — Include code interpreter outputs
- `file_search_call.results` — Include file search results
- `message.input_image.image_url` — Include input image URLs
- `message.output_text.logprobs` — Include logprobs with messages
- `reasoning.encrypted_content` — Include encrypted reasoning tokens

#### Tools Configuration

**Web Search Tool:**
```json
{
  "type": "web_search_preview",
  "search_context_size": "medium"
}
```

**File Search Tool:**
```json
{
  "type": "file_search",
  "vector_store_ids": ["vs_abc123"],
  "max_num_results": 20
}
```

**Function Calling Tool:**
```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Get current weather for a location",
  "parameters": {
    "type": "object",
    "properties": {
      "location": { "type": "string", "description": "City name" }
    },
    "required": ["location"]
  }
}
```

**MCP (Model Context Protocol) Tool:**
```json
{
  "type": "mcp",
  "server_label": "my-mcp-server",
  "server_url": "https://my-mcp-server.example.com",
  "allowed_tools": ["tool1", "tool2"]
}
```

**Code Interpreter Tool:**
```json
{
  "type": "code_interpreter",
  "container": { "type": "auto" }
}
```

#### Example: Simple Text Request

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "Tell me a three sentence bedtime story about a unicorn."
  }'
```

#### Example: With System Instructions

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "instructions": "You are a helpful coding assistant. Always provide code examples.",
    "input": "How do I read a file in Python?"
  }'
```

#### Example: Web Search

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "What are the latest news about AI?",
    "tools": [
      { "type": "web_search_preview" }
    ],
    "include": ["web_search_call.action.sources"]
  }'
```

#### Example: File Search with Vector Store

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "What does the documentation say about authentication?",
    "tools": [
      {
        "type": "file_search",
        "vector_store_ids": ["vs_abc123"],
        "max_num_results": 10
      }
    ],
    "include": ["file_search_call.results"]
  }'
```

#### Example: Function Calling

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "What is the weather in San Francisco?",
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "Get current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string", "description": "City name" },
            "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
          },
          "required": ["location"]
        }
      }
    ]
  }'
```

#### Example: MCP Server Integration

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "Search my Google Drive for Q4 reports",
    "tools": [
      {
        "type": "mcp",
        "server_label": "google-drive",
        "server_url": "https://mcp.example.com/google-drive",
        "allowed_tools": ["search_files", "read_file"]
      }
    ]
  }'
```

#### Example: Image Input

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": [
      { "type": "input_text", "text": "What is in this image?" },
      { "type": "input_image", "image_url": "https://example.com/image.png" }
    ]
  }'
```

#### Example: Multi-turn Conversation

```bash
# First request
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "My name is Alice."
  }'

# Response includes "id": "resp_abc123..."

# Second request with previous_response_id
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "What is my name?",
    "previous_response_id": "resp_abc123..."
  }'
```

#### Example: Streaming Response

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "Write a short poem about coding.",
    "stream": true
  }'
```

#### Example: Structured Output (JSON Schema)

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "Extract the name and age from: John is 30 years old.",
    "text": {
      "format": {
        "type": "json_schema",
        "name": "person_info",
        "schema": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "age": { "type": "integer" }
          },
          "required": ["name", "age"]
        }
      }
    }
  }'
```

#### Example: Reasoning Model Configuration

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "o3",
    "input": "Solve this complex math problem: ...",
    "reasoning": {
      "effort": "high",
      "summary": "auto"
    }
  }'
```

#### Example: Combined Tools (Web Search + Function Calling)

```bash
curl -X POST http://localhost:3002/openai2 \
  -H "Content-Type: application/json" \
  -d '{
    "security_key": "your-secret-key",
    "model": "gpt-4o",
    "input": "Find the current stock price of Apple and calculate a 10% increase",
    "tools": [
      { "type": "web_search_preview" },
      {
        "type": "function",
        "name": "calculate_percentage",
        "description": "Calculate percentage of a number",
        "parameters": {
          "type": "object",
          "properties": {
            "number": { "type": "number" },
            "percentage": { "type": "number" }
          },
          "required": ["number", "percentage"]
        }
      }
    ],
    "parallel_tool_calls": true
  }'
```

#### Response

Standard OpenAI Responses API response:

```json
{
  "id": "resp_67ccd2bed1ec8190b14f964abc054267...",
  "object": "response",
  "created_at": 1741476542,
  "status": "completed",
  "completed_at": 1741476543,
  "model": "gpt-4o-2024-08-06",
  "output": [
    {
      "type": "message",
      "id": "msg_67ccd2bf17f0819081ff3bb2cf6508e6...",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "In a peaceful grove beneath a silver moon...",
          "annotations": []
        }
      ]
    }
  ],
  "parallel_tool_calls": true,
  "reasoning": { "effort": null, "summary": null },
  "store": true,
  "temperature": 1.0,
  "tool_choice": "auto",
  "tools": [],
  "usage": {
    "input_tokens": 36,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens": 87,
    "output_tokens_details": { "reasoning_tokens": 0 },
    "total_tokens": 123
  }
}
```

---

### `GET /openai2/:response_id`

**Retrieve a stored response by ID.**

#### Query Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `openai_api_key` | string | ❌ | Override the default API key |
| `project` | string | ❌ | OpenAI project ID |
| `organization` | string | ❌ | OpenAI organization ID |

#### Example Request

```bash
curl "http://localhost:3002/openai2/resp_abc123?security_key=your-secret-key"
```

---

### `DELETE /openai2/:response_id`

**Delete a stored response.**

#### Query Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `openai_api_key` | string | ❌ | Override the default API key |

#### Example Request

```bash
curl -X DELETE "http://localhost:3002/openai2/resp_abc123?security_key=your-secret-key"
```

#### Response

```json
{
  "id": "resp_abc123",
  "object": "response",
  "deleted": true
}
```

---

### `POST /openai2/:response_id/cancel`

**Cancel a background response** (only for responses created with `background: true`).

#### Request Body (JSON)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `openai_api_key` | string | ❌ | Override the default API key |

#### Example Request

```bash
curl -X POST http://localhost:3002/openai2/resp_abc123/cancel \
  -H "Content-Type: application/json" \
  -d '{ "security_key": "your-secret-key" }'
```

---

### `GET /openai2/:response_id/input_items`

**List input items for a response.**

#### Query Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `security_key` | string | ✅ | Must match `SECURITY_KEY` env variable |
| `openai_api_key` | string | ❌ | Override the default API key |

#### Example Request

```bash
curl "http://localhost:3002/openai2/resp_abc123/input_items?security_key=your-secret-key"
```

#### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "msg_abc123",
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Tell me a story." }
      ]
    }
  ],
  "first_id": "msg_abc123",
  "last_id": "msg_abc123",
  "has_more": false
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