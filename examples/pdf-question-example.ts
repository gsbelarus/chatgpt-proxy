/**
 * Пример использования chatgpt-proxy для анализа PDF документа
 * 
 * Этот скрипт демонстрирует:
 * 1. Чтение PDF файла с диска
 * 2. Отправку файла на прокси-сервер
 * 3. Получение и обработку ответа от ChatGPT
 */

import * as fs from "fs";
import * as path from "path";
import FormData from "form-data";

// Конфигурация прокси-сервера
const PROXY_URL = "http://localhost:3002/openai";
const SECURITY_KEY = process.env.SECURITY_KEY || "your-security-key";

// Путь к PDF файлу (укажите свой путь)
const PDF_FILE_PATH = "./document.pdf";

// Вопрос к документу
const QUESTION = "Пожалуйста, проанализируй этот документ и предоставь краткое содержание.";

interface UploadedFile {
  file_id: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface ProxyResponse {
  response: {
    id: string;
    object: string;
    created_at: number;
    status: string;
    model: string;
    output: Array<{
      type: string;
      id: string;
      status: string;
      role: string;
      content: Array<{
        type: string;
        text: string;
        annotations?: any[];
      }>;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  };
  uploaded_files: UploadedFile[];
}

/**
 * Отправляет PDF файл и вопрос на прокси-сервер
 */
async function askQuestionAboutPDF(
  filePath: string,
  question: string,
  options?: {
    model?: string;
    openaiApiKey?: string;
    project?: string;
  }
): Promise<ProxyResponse> {
  // Проверяем существование файла
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  const absolutePath = path.resolve(filePath);
  const filename = path.basename(filePath);

  console.log(`📄 Загружаю файл: ${filename}`);
  console.log(`📁 Путь: ${absolutePath}`);
  console.log(`❓ Вопрос: ${question}`);

  // Создаём FormData с файлом и параметрами
  const formData = new FormData();

  // Добавляем файл
  formData.append("file", fs.createReadStream(absolutePath), {
    filename: filename,
    contentType: "application/pdf",
  });

  // Добавляем обязательные параметры
  formData.append("security_key", SECURITY_KEY);
  formData.append("input_text", question);

  // Указываем purpose для PDF файлов (рекомендация OpenAI)
  formData.append("file_purpose", "user_data");

  // Указываем модель с поддержкой vision (для PDF)
  formData.append("model", options?.model || "gpt-4.1");

  // Опциональные параметры
  if (options?.openaiApiKey) {
    formData.append("openai_api_key", options.openaiApiKey);
  }
  if (options?.project) {
    formData.append("project", options.project);
  }

  // Отправляем запрос
  console.log(`\n🚀 Отправляю запрос на ${PROXY_URL}...`);

  const response = await fetch(PROXY_URL, {
    method: "POST",
    body: formData as any,
    headers: formData.getHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ошибка сервера (${response.status}): ${errorText}`);
  }

  const result: ProxyResponse = await response.json();
  return result;
}

/**
 * Извлекает текстовый ответ из response
 */
function extractTextFromResponse(response: ProxyResponse): string {
  const output = response.response.output;

  if (!output || output.length === 0) {
    return "Ответ отсутствует";
  }

  const texts: string[] = [];

  for (const item of output) {
    if (item.type === "message" && item.content) {
      for (const content of item.content) {
        if (content.type === "output_text" && content.text) {
          texts.push(content.text);
        }
      }
    }
  }

  return texts.join("\n\n") || "Ответ не содержит текста";
}

/**
 * Главная функция
 */
async function main(): Promise<void> {
  console.log("═".repeat(60));
  console.log("🤖 PDF Analyzer с использованием ChatGPT Proxy");
  console.log("═".repeat(60));

  try {
    // Отправляем запрос
    const result = await askQuestionAboutPDF(PDF_FILE_PATH, QUESTION);

    console.log("\n✅ Запрос выполнен успешно!\n");
    console.log("─".repeat(60));

    // Информация о загруженных файлах
    console.log("📎 Загруженные файлы:");
    for (const file of result.uploaded_files) {
      console.log(`   - ${file.filename} (ID: ${file.file_id}, размер: ${file.size} байт)`);
    }

    // Информация об использовании токенов
    if (result.response.usage) {
      const usage = result.response.usage;
      console.log("\n📊 Использование токенов:");
      console.log(`   - Входных: ${usage.input_tokens}`);
      console.log(`   - Выходных: ${usage.output_tokens}`);
      console.log(`   - Всего: ${usage.total_tokens}`);
    }

    // Ответ от модели
    console.log("\n─".repeat(60));
    console.log("💬 Ответ ChatGPT:\n");
    console.log(extractTextFromResponse(result));
    console.log("\n" + "═".repeat(60));

  } catch (error) {
    console.error("\n❌ Ошибка:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Запуск
main();
