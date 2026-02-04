import http from "http";
import { config } from "dotenv";
import OpenAI, { toFile } from "openai";
import Busboy from "busboy";
import { AudioResponseFormat } from "openai/resources";

config({ path: [".env.local", ".env"] });

const defaultModel = "gpt-5-nano";

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

function handleOpenAIError(res: http.ServerResponse, err: unknown) {
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 500;
    const errorPayload = err.error ?? {
      message: err.message,
      type: "api_error",
      param: null,
      code: null,
    };

    logError(`OpenAI request failed: ${errorPayload.message ?? err.message}`);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: errorPayload }, null, 2));
    return true;
  }

  return false;
}

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
  max_completion_tokens?: number;
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
  const accessToken = process.env.ACCESS_TOKEN;

  return (
    Boolean(accessToken) && searchParams.get("access_token") === accessToken
  );
}

export const server = http.createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow all origins
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"); // Allow specific methods
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
          model: defaultModel,
          temperature: 1,
        },
      });

      const gptResponse = await chatAPI.sendMessage("Who are you?", {
        systemMessage: `You are an AI assistant.`,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gptResponse, null, 2));
    } catch (err: unknown) {
      if (handleOpenAIError(res, err)) return;
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
        model: defaultModel,
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

        // If there is image, add it to messages per Chat Completions schema
        let completionPayload = { ...create_chat_completion };

        if (completionPayload.stream) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Streaming is not supported on this endpoint");
          return;
        }

        if (image) {
          const imagePart = image.url
            ? { type: "image_url", image_url: { url: image.url } }
            : image.base64
              ? {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${image.base64}` },
              }
              : null;

          if (!imagePart) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid image payload");
            return;
          }

          if (!completionPayload.messages) completionPayload.messages = [];

          const lastMessage =
            completionPayload.messages[completionPayload.messages.length - 1];

          if (lastMessage?.role === "user") {
            if (typeof lastMessage.content === "string") {
              lastMessage.content = [
                { type: "text", text: lastMessage.content },
                imagePart,
              ];
            } else if (Array.isArray(lastMessage.content)) {
              lastMessage.content = [...lastMessage.content, imagePart];
            } else {
              lastMessage.content = [imagePart];
            }
          } else {
            completionPayload.messages.push({
              role: "user",
              content: [imagePart],
            });
          }
        }

        chatCompletion =
          await openai.chat.completions.create(completionPayload);
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
      if (handleOpenAIError(res, err)) return;
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

      const {
        prompt,
        model,
        temperature,
        top_p,
        max_tokens,
        max_completion_tokens,
        security_key,
      } = data;

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const useModel = model ?? defaultModel;

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
          max_completion_tokens,
        } as any,
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
  } else if (
    req.url === "/openai/audio/transcriptions" &&
    req.method === "POST"
  ) {
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
      let timestamp_granularities: Array<"word" | "segment"> | undefined =
        undefined;
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
          if (fieldname === "response_format")
            response_format = val as AudioResponseFormat;
          if (fieldname === "timestamp_granularities[]") {
            timestamp_granularities ??= [];
            timestamp_granularities.push(val as "word" | "segment");
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

      // Convert buffer to file without writing to disk
      const audioFile = await toFile(audioBuffer, audioFilename);

      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model,
        response_format,
        language,
        prompt,
        temperature,
        timestamp_granularities,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(transcription, null, 2));
    } catch (err: unknown) {
      if (handleOpenAIError(res, err)) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Audio transcription failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url === "/openai2" && req.method === "POST") {
    // OpenAI Responses API endpoint
    // https://platform.openai.com/docs/api-reference/responses
    const started = Date.now();
    let createResponseText = "";

    try {
      const body = await getBody(req);
      const data = JSON.parse(body);

      const {
        security_key,
        openai_api_key,
        project,
        organization,
        timeout,
        stream,
        ...responsesPayload
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

      currentParallelRequests++;

      if (currentParallelRequests > maxParallelRequests) {
        maxParallelRequests = currentParallelRequests;
      }

      try {
        createResponseText = JSON.stringify(responsesPayload, null, 2);

        if (stream) {
          // Streaming response using Server-Sent Events
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const streamResponse = openai.responses.stream({
            ...responsesPayload,
          });

          streamResponse.on("event", (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          });

          await streamResponse.finalResponse();

          res.write("data: [DONE]\n\n");
          res.end();

          const requestTime = (Date.now() - started) / 1000;
          requestCount++;
          totalRequestTime += requestTime;

          if (requestTime > maxRequestTime) {
            maxRequestTime = requestTime;
          }

          logInfo(`
<strong>Responses API Streaming Request #${requestCount}:</strong> ${createResponseText}

<strong>Request successful in ${requestTime.toFixed(1)}s...</strong>
`);
        } else {
          // Non-streaming response
          const response = await openai.responses.create(responsesPayload);

          const responseText = JSON.stringify(response, null, 2);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(responseText);

          requestCount++;
          const requestTime = (Date.now() - started) / 1000;
          totalRequestTime += requestTime;

          if (requestTime > maxRequestTime) {
            maxRequestTime = requestTime;
          }

          const promptTokenCount = response.usage?.input_tokens ?? 0;
          const cachedTokenCount =
            response.usage?.input_tokens_details?.cached_tokens ?? 0;
          const completionTokenCount = response.usage?.output_tokens ?? 0;

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
<strong>Responses API Request #${requestCount}:</strong> ${createResponseText}

<strong>Response:</strong> ${responseText}

<strong>Request successful in ${requestTime.toFixed(1)}s...</strong> Input tokens: ${promptTokenCount}, Cached tokens: ${cachedTokenCount}, Output tokens: ${completionTokenCount}
`);
        }
      } finally {
        currentParallelRequests--;
      }
    } catch (err: unknown) {
      if (handleOpenAIError(res, err)) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const requestTime = (Date.now() - started) / 1000;

      logError(`
Responses API request failed: ${errorMessage}

<strong>Request:</strong> ${createResponseText}

<strong>Request done in ${requestTime.toFixed(1)}s...</strong>
`);

      errorCount++;
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url?.startsWith("/openai2/") && req.method === "GET") {
    // GET /openai2/:response_id - Retrieve a response by ID
    try {
      const body = await getBody(req);
      let security_key = "";
      let openai_api_key = "";
      let project = "";
      let organization = "";

      // Parse query parameters for auth
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      security_key = urlObj.searchParams.get("security_key") || "";
      openai_api_key = urlObj.searchParams.get("openai_api_key") || "";
      project = urlObj.searchParams.get("project") || "";
      organization = urlObj.searchParams.get("organization") || "";

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const responseId = req.url.split("/openai2/")[1]?.split("?")[0];

      if (!responseId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing response_id");
        return;
      }

      const openai = new OpenAI({
        apiKey: openai_api_key || (process.env.OPENAI_API_KEY as string),
        project: project || (process.env.OPENAI_PROJECT_KEY ?? null),
        organization: organization ?? null,
      });

      const response = await openai.responses.retrieve(responseId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response, null, 2));
    } catch (err: unknown) {
      if (handleOpenAIError(res, err)) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Responses API retrieve failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (
    req.url?.startsWith("/openai2/") &&
    req.url?.endsWith("/cancel") &&
    req.method === "POST"
  ) {
    // POST /openai2/:response_id/cancel - Cancel a background response
    try {
      const body = await getBody(req);
      const data = body ? JSON.parse(body) : {};

      const { security_key, openai_api_key, project, organization } = data;

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const responseId = req.url
        .split("/openai2/")[1]
        ?.replace("/cancel", "")
        ?.split("?")[0];

      if (!responseId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing response_id");
        return;
      }

      const openai = new OpenAI({
        apiKey: openai_api_key || (process.env.OPENAI_API_KEY as string),
        project: project || (process.env.OPENAI_PROJECT_KEY ?? null),
        organization: organization ?? null,
      });

      const response = await openai.responses.cancel(responseId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response, null, 2));

      logInfo(`Responses API cancel successful for: ${responseId}`);
    } catch (err: unknown) {
      if (handleOpenAIError(res, err)) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Responses API cancel failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url?.startsWith("/openai2/") && req.method === "DELETE") {
    // DELETE /openai2/:response_id - Delete a response
    try {
      // Parse query parameters for auth
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const security_key = urlObj.searchParams.get("security_key") || "";
      const openai_api_key = urlObj.searchParams.get("openai_api_key") || "";
      const project = urlObj.searchParams.get("project") || "";
      const organization = urlObj.searchParams.get("organization") || "";

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const responseId = req.url.split("/openai2/")[1]?.split("?")[0];

      if (!responseId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing response_id");
        return;
      }

      const openai = new OpenAI({
        apiKey: openai_api_key || (process.env.OPENAI_API_KEY as string),
        project: project || (process.env.OPENAI_PROJECT_KEY ?? null),
        organization: organization ?? null,
      });

      // Use the beta API for delete
      const response = await openai.responses.delete(responseId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response, null, 2));

      logInfo(`Responses API delete successful for: ${responseId}`);
    } catch (err: unknown) {
      if (handleOpenAIError(res, err)) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Responses API delete failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (
    req.url?.startsWith("/openai2/") &&
    req.url?.endsWith("/input_items") &&
    req.method === "GET"
  ) {
    // GET /openai2/:response_id/input_items - List input items for a response
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const security_key = urlObj.searchParams.get("security_key") || "";
      const openai_api_key = urlObj.searchParams.get("openai_api_key") || "";
      const project = urlObj.searchParams.get("project") || "";
      const organization = urlObj.searchParams.get("organization") || "";

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const responseId = req.url
        .split("/openai2/")[1]
        ?.replace("/input_items", "")
        ?.split("?")[0];

      if (!responseId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing response_id");
        return;
      }

      const openai = new OpenAI({
        apiKey: openai_api_key || (process.env.OPENAI_API_KEY as string),
        project: project || (process.env.OPENAI_PROJECT_KEY ?? null),
        organization: organization ?? null,
      });

      const inputItems = await openai.responses.inputItems.list(responseId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(inputItems, null, 2));
    } catch (err: unknown) {
      if (handleOpenAIError(res, err)) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Responses API input_items failed: ${errorMessage}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
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
      if (handleOpenAIError(res, err)) return;
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
