/**
 * Альтернативный пример с использованием расширенного payload
 * 
 * Этот пример демонстрирует более гибкий способ работы с API,
 * позволяя передавать дополнительные параметры через поле payload
 */

import * as fs from "fs";
import * as path from "path";
import FormData from "form-data";

const PROXY_URL = "http://localhost:3002/openai";
const SECURITY_KEY = process.env.SECURITY_KEY || "your-security-key";

interface ChatGPTResponse {
  response: any;
  uploaded_files: Array<{
    file_id: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
}

/**
 * Расширенный запрос с дополнительными параметрами
 */
async function analyzeDocumentAdvanced(
  filePath: string,
  question: string,
  systemPrompt?: string
): Promise<ChatGPTResponse> {
  const absolutePath = path.resolve(filePath);
  const filename = path.basename(filePath);

  const formData = new FormData();

  // Файл
  formData.append("file", fs.createReadStream(absolutePath), {
    filename: filename,
    contentType: "application/pdf",
  });

  // Обязательные параметры
  formData.append("security_key", SECURITY_KEY);
  formData.append("file_purpose", "user_data");

  // Расширенный payload с дополнительными настройками
  const payload = {
    model: "gpt-4.1",
    instructions: systemPrompt || "Ты эксперт по анализу документов. Отвечай подробно и структурированно.",
    temperature: 0.7,
    max_output_tokens: 4096,
    // Можно также указать input напрямую (файлы будут добавлены автоматически)
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: question,
          },
          // file_id будет добавлен автоматически прокси-сервером
        ],
      },
    ],
  };

  formData.append("payload", JSON.stringify(payload));

  const response = await fetch(PROXY_URL, {
    method: "POST",
    body: formData as any,
    headers: formData.getHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

/**
 * Пример: Многократные вопросы к одному документу
 * (используя ID уже загруженного файла)
 */
async function askFollowUpQuestion(
  fileId: string,
  question: string
): Promise<any> {
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      security_key: SECURITY_KEY,
      model: "gpt-4.1",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: question,
            },
            // Примечание: для Chat Completions API используется другой формат
            // Для работы с file_id рекомендуется использовать Responses API
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

/**
 * Пример использования с JSON через обычный POST (без multipart)
 * Для случаев, когда файл уже загружен или используется URL
 */
async function analyzeWithFileUrl(
  fileUrl: string,
  question: string
): Promise<any> {
  // Используем endpoint с поддержкой Responses API payload
  const formData = new FormData();

  formData.append("security_key", SECURITY_KEY);

  const payload = {
    model: "gpt-4.1",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: question,
          },
          {
            type: "input_file",
            file_url: fileUrl, // URL до PDF файла
          },
        ],
      },
    ],
  };

  formData.append("payload", JSON.stringify(payload));

  const response = await fetch(PROXY_URL, {
    method: "POST",
    body: formData as any,
    headers: formData.getHeaders(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

// Демонстрация
async function main(): Promise<void> {
  console.log("Расширенный пример анализа PDF\n");

  // Проверяем наличие тестового файла
  const testFile = "./document.pdf";

  if (!fs.existsSync(testFile)) {
    console.log("⚠️  Файл document.pdf не найден.");
    console.log("   Создайте файл document.pdf в текущей директории для тестирования.\n");
    console.log("   Либо используйте analyzeWithFileUrl() с URL до PDF файла.");
    return;
  }

  try {
    const result = await analyzeDocumentAdvanced(
      testFile,
      "Перечисли основные разделы этого документа и кратко опиши каждый.",
      "Ты опытный аналитик документов. Структурируй информацию в виде списка."
    );

    console.log("✅ Успешно!\n");
    console.log("Загруженные файлы:", result.uploaded_files);
    console.log("\nСтатус:", result.response.status);

    // Извлекаем текст ответа
    const outputText = result.response.output
      ?.filter((item: any) => item.type === "message")
      .flatMap((item: any) => item.content)
      .filter((c: any) => c.type === "output_text")
      .map((c: any) => c.text)
      .join("\n");

    console.log("\nОтвет:\n", outputText);

  } catch (error) {
    console.error("❌ Ошибка:", error);
  }
}

main();
