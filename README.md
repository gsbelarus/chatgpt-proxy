# chatgpt-proxy

Прокси-сервис для OpenAI/ChatGPT с REST-эндпоинтами.

## Переменные окружения

- `OPENAI_API_KEY` — ключ OpenAI (обязателен, если не передаётся в запросе)
- `OPENAI_PROJECT_KEY` — ключ проекта (опционально)
- `SECURITY_KEY` — секрет для доступа к прокси (обязателен)

## Общие правила

- Авторизация: передавайте `security_key` в теле запроса или форме.
- Таймаут сервера: 15 минут.
- CORS включён для всех источников.

## Эндпоинты

### GET /

Проверка доступности сервиса.

**Ответ**: HTML-страница.

---

### POST /openai

Проксирует OpenAI Chat Completions API.

**Content-Type**: `application/json` **или** `multipart/form-data`

**Тело запроса** (JSON):

- `security_key` (string, обязательный)
- `openai_api_key` (string, опционально)
- `project` (string, опционально)
- `organization` (string, опционально)
- `image` (object, опционально) — поддержка одного изображения:
	- `url` (string) или `base64` (string)
- Любые остальные поля будут переданы в `openai.chat.completions.create` как есть

**Пример**:

```
POST /openai
Content-Type: application/json

{
	"security_key": "...",
	"model": "gpt-4o-mini",
	"messages": [
		{ "role": "user", "content": "Привет!" }
	]
}
```

**Ответ**: JSON ответа OpenAI Chat Completions.

**Пример (TypeScript fetch, JSON без файлов)**:

```ts
type ChatCompletionsResponse = {
	id: string;
	choices: Array<{
		message?: { role: string; content?: string };
		finish_reason?: string;
	}>;
};

async function callOpenAIJson(): Promise<void> {
	const response = await fetch("http://localhost:3002/openai", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			security_key: "YOUR_KEY",
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: "Привет!" }],
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`HTTP ${response.status}: ${text}`);
	}

	const data = (await response.json()) as ChatCompletionsResponse;
	const answer = data.choices?.[0]?.message?.content ?? "";
	console.log("Answer:", answer);
}
```

**Дополнительно (multipart/form-data с файлами)**:

Если запрос отправлен как `multipart/form-data` и содержит файлы, эндпоинт:

- загружает файлы через OpenAI Files API,
- вызывает `openai.responses.create`,
- прикладывает файлы в `input`.

**Поля формы**:

- `security_key` (string, обязательный)
- `openai_api_key` (string, опционально)
- `project` (string, опционально)
- `organization` (string, опционально)
- `model` (string, опционально; по умолчанию `gpt-4o-mini`)
- `input_text` (string, опционально)
- `payload` (string, JSON, опционально) — payload для `openai.responses.create`
- `file_purpose` (string, опционально; по умолчанию `assistants`)

**Файлы**:

- Любое количество файлов (любой fieldname)

**Ответ**: JSON c полями `response` и `uploaded_files`.

**Пример (TypeScript fetch, multipart с файлами)**:

```ts
type ResponsesWithFiles = {
	response: {
		id: string;
		output?: Array<{ content?: Array<{ type: string; text?: string }> }>;
	};
	uploaded_files: Array<{
		file_id: string;
		filename: string;
		mimeType: string;
		size: number;
	}>;
};

async function callOpenAIWithFiles(files: File[]): Promise<void> {
	const form = new FormData();
	form.set("security_key", "YOUR_KEY");
	form.set("model", "gpt-4o-mini");
	form.set("input_text", "Сделай краткое резюме документов");

	for (const file of files) {
		form.append("files", file, file.name);
	}

	const response = await fetch("http://localhost:3002/openai", {
		method: "POST",
		body: form,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`HTTP ${response.status}: ${text}`);
	}

	const data = (await response.json()) as ResponsesWithFiles;
	const firstOutput = data.response.output?.[0]?.content?.[0]?.text ?? "";
	console.log("Answer:", firstOutput);
	console.log("Uploaded:", data.uploaded_files);
}
```

---

### POST /openai/with-files

Позволяет отправлять массив файлов вместе с запросом. Файлы могут быть любыми: JPG, PNG, PDF, DOC, XLS и т.д.

**Content-Type**: `multipart/form-data`

**Поля формы**:

- `security_key` (string, обязательный)
- `openai_api_key` (string, опционально)
- `project` (string, опционально)
- `organization` (string, опционально)
- `model` (string, опционально; по умолчанию `gpt-4o-mini`)
- `input_text` (string, опционально) — текст вопроса/инструкции
- `payload` (string, JSON, опционально) — полный payload для `openai.responses.create`
- `file_purpose` (string, опционально; по умолчанию `assistants`)

**Файлы**:

- Передайте один или несколько файлов как `files` или `files[]` (любой fieldname допустим — будут приняты все файловые части).

**Как формируется запрос к OpenAI**:

- Файлы сначала загружаются в OpenAI Files API.
- Затем создаётся запрос `openai.responses.create`.
- Если `payload` не указан, создаётся стандартный `input` с текстом и файлами.
- Если `payload` указан, файлы будут добавлены в `input` (первый элемент с `content`).

**Пример (cURL)**:

```bash
curl -X POST http://localhost:3002/openai/with-files \
  -F "security_key=YOUR_KEY" \
  -F "model=gpt-4o-mini" \
  -F "input_text=Сделай краткое резюме документов" \
  -F "files=@./docs/contract.pdf" \
  -F "files=@./docs/report.docx"
```

**Пример (TypeScript fetch)**:

```ts
type ResponsesWithFiles = {
  response: {
    id: string;
    output?: Array<{ content?: Array<{ type: string; text?: string }> }>;
  };
  uploaded_files: Array<{
    file_id: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
};

async function analyzeDocuments(
  files: File[],
  instruction: string
): Promise<string> {
  const form = new FormData();
  form.set("security_key", "YOUR_KEY");
  form.set("model", "gpt-4o-mini");
  form.set("input_text", instruction);

  for (const file of files) {
    form.append("files", file, file.name);
  }

  const response = await fetch("http://localhost:3002/openai/with-files", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as ResponsesWithFiles;
  const firstOutput = data.response.output?.[0]?.content?.[0]?.text ?? "";
  console.log("Uploaded files:", data.uploaded_files);
  return firstOutput;
}
```

**Ответ**:

```json
{
  "response": { ... },
  "uploaded_files": [
    {
      "file_id": "file_...",
      "filename": "contract.pdf",
      "mimeType": "application/pdf",
      "size": 12345
    }
  ]
}
```

---

### POST /chatgpt

Проксирует библиотеку `chatgpt` (legacy-режим).

**Content-Type**: `application/json`

**Тело запроса** (JSON):

- `prompt` (string, обязательный)
- `security_key` (string, обязательный)
- `model` (string, опционально; по умолчанию `gpt-4o-mini`)
- `temperature` (number, опционально; 0–2, по умолчанию 1)
- `top_p` (number, опционально; 0–1, по умолчанию 1)
- `max_tokens`, `max_completion_tokens` (number, опционально)

**Ответ**: JSON ответа модели.

**Пример (TypeScript fetch)**:

```ts
type ChatGPTResponse = {
  id: string;
  text: string;
  role: string;
};

async function callChatGPT(prompt: string): Promise<string> {
  const response = await fetch("http://localhost:3002/chatgpt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      security_key: "YOUR_KEY",
      prompt,
      model: "gpt-4o-mini",
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as ChatGPTResponse;
  return data.text;
}
```

---

### POST /openai/audio/transcriptions

Распознавание аудио (Whisper).

**Content-Type**: `multipart/form-data`

**Поля формы**:

- `security_key` (string, обязательный)
- `openai_api_key`, `project`, `organization` (опционально)
- `model` (string, по умолчанию `whisper-1`)
- `language`, `prompt`, `temperature`, `response_format`
- `timestamp_granularities[]` (можно указать несколько)

**Файл**:

- Один аудиофайл в `file` (или любой file field)

**Ответ**: JSON результата транскрипции.

**Пример (TypeScript fetch)**:

```ts
type TranscriptionResponse = {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<{ text: string; start: number; end: number }>;
};

async function transcribeAudio(audioFile: File): Promise<string> {
  const form = new FormData();
  form.set("security_key", "YOUR_KEY");
  form.set("model", "whisper-1");
  form.set("language", "ru");
  form.set("response_format", "verbose_json");
  form.append("file", audioFile, audioFile.name);

  const response = await fetch(
    "http://localhost:3002/openai/audio/transcriptions",
    {
      method: "POST",
      body: form,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as TranscriptionResponse;
  return data.text;
}
```

---

### POST /embeddings

Проксирует OpenAI Embeddings API.

**Content-Type**: `application/json`

**Тело запроса** (JSON):

- `security_key` (string, обязательный)
- `input` (string | string[] | number[] | number[][]) — данные для эмбеддингов
- `model` (string, опционально; по умолчанию `text-embedding-3-large`)
- `dimensions` (number, опционально)
- `encoding_format` (string, опционально)

**Ответ**: JSON эмбеддингов.

**Пример (TypeScript fetch)**:

```ts
type EmbeddingsResponse = {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
};

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await fetch("http://localhost:3002/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      security_key: "YOUR_KEY",
      input: texts,
      model: "text-embedding-3-large",
      dimensions: 1024,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as EmbeddingsResponse;
  return data.data.map((item) => item.embedding);
}
```
