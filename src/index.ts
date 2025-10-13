import http from "http";
import { config } from "dotenv";
import OpenAI from "openai";
import Busboy from "busboy";
import path from "path";
import { createReadStream } from "fs";
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { AudioResponseFormat } from "openai/resources";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({ path: [".env.local", ".env"] });

type LogEntry = {
  type: "ERROR" | "INFO" | "DEBUG";
  message: string;
  timestamp: Date;
};

const infos: LogEntry[] = [];
const errors: LogEntry[] = [];
const maxLogLength = 50;

let requestCount = 0;
let totalRequestTime = 0;
let maxRequestTime = 0;
let maxParallelRequests = 0;
let currentParallelRequests = 0;
let maxPromptTokens = 0;
let maxCachedTokens = 0;
let maxCompletionTokens = 0;
let errorCount = 0;
let lastLogTime = 0;

function logError(message: string) {
  errors.push({ type: "ERROR", message, timestamp: new Date() });
  if (errors.length > maxLogLength) {
    errors.splice(0, errors.length - maxLogLength);
  }
}

function logInfo(message: string) {
  infos.push({ type: "INFO", message, timestamp: new Date() });
  if (infos.length > maxLogLength) {
    infos.splice(0, infos.length - maxLogLength);
  }
}

const { ChatGPTAPI } = await import("chatgpt");

function getBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyParts: any[] = [];
    request
      .on("data", (chunk) => {
        bodyParts.push(chunk);
      })
      .on("end", () => {
        const body = Buffer.concat(bodyParts).toString();
        resolve(body);
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}

type ChatGPTRequest = {
  prompt: string;
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  security_key: string;
};

function isChatGPTRequest(object: any): object is ChatGPTRequest {
  return (
    typeof object === "object" &&
    object !== null &&
    "prompt" in object &&
    typeof object.prompt === "string" &&
    "security_key" in object &&
    typeof object.security_key === "string" &&
    (object.model === undefined || typeof object.model === "string") &&
    (object.temperature === undefined ||
      (typeof object.temperature === "number" &&
        object.temperature >= 0 &&
        object.temperature <= 2)) &&
    (object.top_p === undefined ||
      (typeof object.top_p === "number" &&
        object.top_p >= 0 &&
        object.top_p <= 1))
  );
}

function checkAccess(req: http.IncomingMessage): boolean {
  const urlObj = new URL(req.url!, `http://${req.headers.host}`);
  const searchParams = urlObj.searchParams;

  return searchParams.get("access_token") === "123";
}

export const server = http.createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow all origins
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); // Allow specific methods
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  ); // Allow specific headers

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  req.setTimeout(900_000); // 15 minutes

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Hello, World!</h1><div>31.01.2025</div>");
  } else if (req.url === "/health") {
    if (Date.now() - lastLogTime < 10_000) {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("Too Many Requests");
      return;
    }

    lastLogTime = Date.now();

    try {
      const chatAPI = new ChatGPTAPI({
        apiKey: process.env.OPENAI_API_KEY as string,
        apiBaseUrl: "https://api.openai.com/v1",
        completionParams: {
          model: "gpt-4o-mini",
          temperature: 1,
        },
      });

      const gptResponse = await chatAPI.sendMessage("Who are you?", {
        systemMessage: `You are an AI assistant.`,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gptResponse, null, 2));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`ChatGPT request failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url === "/health2") {
    if (Date.now() - lastLogTime < 10_000) {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("Too Many Requests");
      return;
    }

    lastLogTime = Date.now();

    try {
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY as string,
      });

      const chatCompletion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an AI assistant.",
          },
          {
            role: "user",
            content: "What is the meaning of life?",
          },
        ],
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(chatCompletion, null, 2));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`ChatGPT request failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url?.startsWith("/log")) {
    if (!checkAccess(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    if (Date.now() - lastLogTime < 10_000) {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("Too Many Requests");
      return;
    }

    lastLogTime = Date.now();

    const avgRequestTime =
      requestCount > 0 ? (totalRequestTime / requestCount).toFixed(1) : "0.0";

    res.writeHead(200, { "Content-Type": "text/html" });

    const initData = req.url?.startsWith("/log_errors")
      ? [...errors]
      : [...infos];

    const body = initData
      .reverse()
      .map(
        (entry) =>
          `<p><strong>${entry.timestamp.toISOString()} [${entry.type}]</strong> ${entry.message}</p>`,
      )
      .join("");
    res.end(
      `<html>
           <meta charset="UTF-8">
           <body>
             <div>Request count: ${requestCount}</div>
             <div>Total request time: ${totalRequestTime.toFixed()}s</div>
             <div>Average request time: ${avgRequestTime}s</div>
             <div>Max request time: ${maxRequestTime.toFixed(1)}s</div>
             <div>Max parallel requests: ${maxParallelRequests}</div>
             <div>Max prompt tokens: ${maxPromptTokens}</div>
             <div>Max cached tokens: ${maxCachedTokens}</div>
             <div>Max completion tokens: ${maxCompletionTokens}</div>
             <div>Error count: ${errorCount}</div>
             <pre>${body}</pre>
           </body>
         </html>`,
    );
  } else if (req.url === "/openai" && req.method === "POST") {
    const started = Date.now();
    let createChatCompletionText = "";

    // This is a ChatGPT v1 API request
    // https://platform.openai.com/docs/api-reference/chat/create
    try {
      const body = await getBody(req);

      //logInfo(`ChatGPT request text: ${body}`);

      const data = JSON.parse(body);

      const {
        security_key,
        openai_api_key,
        project,
        organization,
        timeout,
        image,
        ...create_chat_completion
      } = data;

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const openai = new OpenAI({
        apiKey: openai_api_key || (process.env.OPENAI_API_KEY as string),
        project: project || (process.env.OPENAI_PROJECT_KEY ?? null),
        organization: organization ?? null,
      });

      let chatCompletion;

      try {
        currentParallelRequests++;

        if (currentParallelRequests > maxParallelRequests) {
          maxParallelRequests = currentParallelRequests;
        }

        // If there is image, add it to messages
        let completionPayload = { ...create_chat_completion };
        if (image) {
          if (!completionPayload.messages) completionPayload.messages = [];
          completionPayload.messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: create_chat_completion.messages?.[0]?.content || "",
              },
              image.url
                ? { type: "image_url", image_url: image.url }
                : image.base64
                  ? {
                      type: "image_url",
                      image_url: `data:image/png;base64,${image.base64}`,
                    }
                  : undefined,
            ].filter(Boolean),
          });
        }

        chatCompletion = await openai.chat.completions.create(completionPayload);
      } finally {
        currentParallelRequests--;
      }

      const chatCompletionText = JSON.stringify(chatCompletion, null, 2);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(chatCompletionText);

      createChatCompletionText = JSON.stringify(
        create_chat_completion,
        null,
        2,
      );

      requestCount++;
      const requestTime = (Date.now() - started) / 1000;
      totalRequestTime += requestTime;

      if (requestTime > maxRequestTime) {
        maxRequestTime = requestTime;
      }

      const promptTokenCount = chatCompletion.usage?.prompt_tokens ?? 0;
      const cachedTokenCount =
        chatCompletion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const completionTokenCount = chatCompletion.usage?.completion_tokens ?? 0;

      if (promptTokenCount > maxPromptTokens) {
        maxPromptTokens = promptTokenCount;
      }

      if (cachedTokenCount > maxCachedTokens) {
        maxCachedTokens = cachedTokenCount;
      }

      if (completionTokenCount > maxCompletionTokens) {
        maxCompletionTokens = completionTokenCount;
      }

      logInfo(`
<strong>Request #${requestCount}:</strong> ${createChatCompletionText}

<strong>Response:</strong> ${chatCompletionText}

<strong>Request successful in ${requestTime.toFixed(1)}s...</strong> Prompt tokens: ${promptTokenCount}, Cached tokens: ${cachedTokenCount}, Completion tokens: ${completionTokenCount}
`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const requestTime = (Date.now() - started) / 1000;

      logError(`
ChatGPT request failed: ${errorMessage}

<strong>Request #${requestCount}:</strong> ${createChatCompletionText}

<strong>Request done in ${requestTime.toFixed(1)}s...</strong>
`);

      errorCount++;
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url === "/chatgpt" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const data = JSON.parse(body);

      if (!isChatGPTRequest(data)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request");
        return;
      }

      const { prompt, model, temperature, top_p, max_tokens, security_key } =
        data;

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const useModel = model ?? "gpt-4o-mini";

      const started = Date.now();
      logInfo(
        `model: ${useModel}, temperature: ${temperature}, prompt: ${prompt}`,
      );

      const chatAPI = new ChatGPTAPI({
        apiKey: process.env.OPENAI_API_KEY as string,
        apiBaseUrl: "https://api.openai.com/v1",
        completionParams: {
          model: useModel,
          temperature: temperature ?? 1,
          top_p: top_p ?? 1,
          max_tokens,
        },
      });

      const gptResponse = await chatAPI.sendMessage(prompt, {
        systemMessage: `You are an AI assistant.`,
      });

      logInfo(
        `ChatGPT request successful in ${(
          (Date.now() - started) /
          1000
        ).toFixed()}s...`,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gptResponse, null, 2));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`ChatGPT request failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url === "/openai/audio/transcriptions" && req.method === "POST") {
    let tempDir;
    let tempPath;
    try {
      // Get the audio file from the request body (expects multipart/form-data)
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith("multipart/form-data")) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Content-Type must be multipart/form-data");
        return;
      }

      let audioBuffer: Buffer | null = null;
      let audioFilename = "audio.wav";
      let security_key = "";
      let project = "";
      let organization = "";
      let openai_api_key = "";
      let language = "";
      let model = "whisper-1";
      let prompt: string | undefined = undefined;
      let temperature = 0;
      let timestamp_granularities: Array<'word' | 'segment'> | undefined = undefined;
      let response_format: AudioResponseFormat = "json";

      await new Promise<void>((resolve, reject) => {
        const busboy = Busboy({ headers: req.headers });
        busboy.on(
          "file",
          (
            fieldname: string,
            file: NodeJS.ReadableStream,
            info: Busboy.FileInfo,
          ) => {
            const { filename } = info;

            const chunks: Buffer[] = [];
            audioFilename = filename || "audio.wav";
            file.on("data", (data: Buffer) => chunks.push(data));
            file.on("end", () => {
              audioBuffer = Buffer.concat(chunks);
            });
          },
        );
        busboy.on("field", (fieldname, val) => {
          if (fieldname === "security_key") security_key = val;
          if (fieldname === "project") project = val;
          if (fieldname === "organization") organization = val;
          if (fieldname === "openai_api_key") openai_api_key = val;
          if (fieldname === "language") language = val;
          if (fieldname === "model") model = val;
          if (fieldname === "prompt") prompt = val;
          if (fieldname === "temperature") temperature = Number(val);
          if (fieldname === "response_format") response_format = val as AudioResponseFormat;
          if (fieldname === "timestamp_granularities[]") {
            timestamp_granularities ??= [];
            timestamp_granularities.push(val as ('word' | 'segment'));
          }
        });
        busboy.on("finish", () => resolve());
        busboy.on("error", reject);
        req.pipe(busboy);
      });

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      if (!audioBuffer) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No audio file uploaded");
        return;
      }

      const openai = new OpenAI({
        apiKey: openai_api_key || process.env.OPENAI_API_KEY,
        project: project || (process.env.OPENAI_PROJECT_KEY ?? null),
        organization: organization ?? null,
      });

      tempDir = path.join(__dirname, 'temp_audio');
      tempPath = path.join(tempDir, audioFilename);      

      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(tempPath, audioBuffer);

      const audioStream = createReadStream(tempPath);
      const transcription = await openai.audio.transcriptions.create({
        file: audioStream,
        model,
        response_format,
        language,
        prompt,
        temperature,
        timestamp_granularities
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(transcription, null, 2));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Audio transcription failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    } finally {
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logError(`Failed to delete temp file ${tempPath}: ${errorMessage}`);
        }
      }      
    }
  } else if (req.url === "/embeddings" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const data = JSON.parse(body);

      const { input, model, security_key, dimensions, encoding_format } = data;

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const started = Date.now();
      logInfo(
        `Embeddings request: ${JSON.stringify({ input, model }, null, 2)}`,
      );

      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY as string,
      });

      const embeddingsResponse = await openai.embeddings.create({
        model: model ?? "text-embedding-3-large",
        input,
        dimensions,
        encoding_format,
      });

      const embeddingsResponseText = JSON.stringify(
        embeddingsResponse,
        null,
        2,
      );

      //logInfo(`Embeddings response: ${embeddingsResponseText}`);
      logInfo(
        `Embeddings request successful in ${(
          (Date.now() - started) /
          1000
        ).toFixed()}s...`,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(embeddingsResponseText);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Embeddings request failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.requestTimeout = 900_000;
server.timeout = 900_000;
server.keepAliveTimeout = 900_000;
server.headersTimeout = 950_000; // Slightly longer than request timeout

const port = 3002;

server.listen(port, () => {
  console.log(
    `Server running on http://localhost:${port}/
     Timeout: ${server.timeout}ms
     Keep Alive Timeout: ${server.keepAliveTimeout}ms
     Headers Timeout: ${server.headersTimeout}ms`,
  );
});
