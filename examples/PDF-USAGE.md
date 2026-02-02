# Инструкции по работе с PDF файлами через ChatGPT Proxy

## Обзор

Этот прокси-сервер позволяет загружать PDF документы и задавать вопросы по их содержимому через OpenAI API.

## Архитектура работы

```
┌─────────────┐     multipart/form-data     ┌───────────────┐
│  Ваш код    │  ────────────────────────▶  │  Proxy Server │
│  (клиент)   │                             │  (localhost)  │
└─────────────┘                             └───────────────┘
                                                    │
                                                    ▼
                                            ┌───────────────┐
                                            │ 1. Files API  │ ──▶ Загрузка файла
                                            │    /v1/files  │     (получение file_id)
                                            └───────────────┘
                                                    │
                                                    ▼
                                            ┌───────────────┐
                                            │ 2. Responses  │ ──▶ Анализ документа
                                            │    API        │     с вопросом
                                            └───────────────┘
                                                    │
                                                    ▼
                                            ┌───────────────┐
                                            │ 3. Ответ      │ ──▶ JSON с результатом
                                            └───────────────┘
```

## Endpoint

```
POST http://localhost:3002/openai
Content-Type: multipart/form-data
```

## Параметры запроса

### Обязательные параметры

| Параметр | Тип | Описание |
|----------|-----|----------|
| `file` | File | PDF файл для анализа |
| `security_key` | string | Ключ авторизации (из .env) |

### Рекомендуемые параметры

| Параметр | Тип | Описание |
|----------|-----|----------|
| `input_text` | string | Вопрос или инструкция по документу |
| `file_purpose` | string | Рекомендуется `"user_data"` для PDF |
| `model` | string | Модель с поддержкой vision (gpt-4.1, gpt-4o и др.) |

### Опциональные параметры

| Параметр | Тип | Описание |
|----------|-----|----------|
| `openai_api_key` | string | Свой API ключ OpenAI (иначе используется из .env) |
| `project` | string | ID проекта OpenAI |
| `organization` | string | ID организации OpenAI |
| `payload` | JSON string | Расширенный payload для Responses API |

## Примеры использования

### Базовый пример (Node.js + form-data)

```typescript
import * as fs from "fs";
import FormData from "form-data";

const formData = new FormData();

// Файл
formData.append("file", fs.createReadStream("./document.pdf"), {
  filename: "document.pdf",
  contentType: "application/pdf",
});

// Параметры
formData.append("security_key", "your-security-key");
formData.append("input_text", "О чём этот документ?");
formData.append("file_purpose", "user_data");
formData.append("model", "gpt-4.1");

// Отправка
const response = await fetch("http://localhost:3002/openai", {
  method: "POST",
  body: formData,
  headers: formData.getHeaders(),
});

const result = await response.json();
console.log(result.response.output[0].content[0].text);
```

### Пример с расширенным payload

```typescript
const payload = {
  model: "gpt-4.1",
  instructions: "Ты эксперт по анализу документов",
  temperature: 0.5,
  max_output_tokens: 2000,
};

formData.append("payload", JSON.stringify(payload));
```

### Пример для браузера (Fetch API)

```javascript
async function analyzePDF(file, question) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("security_key", "your-security-key");
  formData.append("input_text", question);
  formData.append("file_purpose", "user_data");
  formData.append("model", "gpt-4.1");

  const response = await fetch("http://localhost:3002/openai", {
    method: "POST",
    body: formData,
  });

  return await response.json();
}

// Использование с input type="file"
const fileInput = document.querySelector('input[type="file"]');
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const result = await analyzePDF(file, "Summarize this document");
  console.log(result);
});
```

### Пример с curl

```bash
curl -X POST http://localhost:3002/openai \
  -F "file=@./document.pdf" \
  -F "security_key=your-security-key" \
  -F "input_text=Проанализируй этот документ" \
  -F "file_purpose=user_data" \
  -F "model=gpt-4.1"
```

## Структура ответа

```json
{
  "response": {
    "id": "resp_abc123...",
    "object": "response",
    "status": "completed",
    "model": "gpt-4.1",
    "output": [
      {
        "type": "message",
        "role": "assistant",
        "content": [
          {
            "type": "output_text",
            "text": "Текст ответа от модели..."
          }
        ]
      }
    ],
    "usage": {
      "input_tokens": 1500,
      "output_tokens": 200,
      "total_tokens": 1700
    }
  },
  "uploaded_files": [
    {
      "file_id": "file-xyz789...",
      "filename": "document.pdf",
      "mimeType": "application/pdf",
      "size": 102400
    }
  ]
}
```

## Ограничения

1. **Размер файла**: до 50 МБ на файл
2. **Общий размер**: до 50 МБ суммарно в одном запросе
3. **Поддерживаемые модели**: только модели с vision (gpt-4o, gpt-4.1 и др.)
4. **Токены**: PDF обрабатывается как текст + изображения страниц

## Обработка ошибок

| Код | Описание |
|-----|----------|
| 400 | Некорректный запрос (нет файла, неверный JSON) |
| 403 | Неверный security_key |
| 429 | Слишком много запросов |
| 500 | Внутренняя ошибка сервера |

## Рекомендации

1. **Используйте `purpose: "user_data"`** для PDF файлов — это рекомендация OpenAI
2. **Выбирайте модель с vision**: gpt-4.1, gpt-4o, gpt-4o-mini, o1
3. **Учитывайте токены**: каждая страница PDF добавляет токены за изображение
4. **Задавайте конкретные вопросы**: чем точнее вопрос, тем лучше ответ

## Установка зависимостей для примеров

```bash
npm install form-data
# или
pnpm add form-data
```

## Запуск примеров

```bash
# Установите переменную окружения
export SECURITY_KEY="your-key"

# Запустите пример
npx tsx examples/pdf-question-example.ts
```
