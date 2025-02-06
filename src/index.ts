import http from "http";
import { config } from "dotenv";
import OpenAI from "openai";

config({ path: [".env.local", ".env"] });

type LogEntry = {
  type: "ERROR" | "INFO" | "DEBUG";
  message: string;
  timestamp: Date;
};

const log: LogEntry[] = [];
const maxLogLength = 1000;
let requestCount = 0;
let totalRequestTime = 0;
let maxRequestTime = 0;
let maxParallelRequests = 0;
let currentParallelRequests = 0;
let maxPromptTokens = 0;
let maxCachedTokens = 0;
let maxCompletionTokens = 0;
let errorCount = 0;

function logError(message: string) {
  console.error(message);
  log.push({ type: "ERROR", message, timestamp: new Date() });
  log.splice(0, log.length - maxLogLength);
}

function logInfo(message: string) {
  log.push({ type: "INFO", message, timestamp: new Date() });
  log.splice(0, log.length - maxLogLength);
}

const { ChatGPTAPI } = await import("chatgpt");

function getBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const bodyParts: any[] = [];
    let body;
    request
      .on("data", (chunk) => {
        bodyParts.push(chunk);
      })
      .on("end", () => {
        body = Buffer.concat(bodyParts).toString();
        resolve(body);
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
    } catch (error: any) {
      logError(`ChatGPT request failed: ${error.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url === "/health2") {
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
    } catch (error: any) {
      logError(`ChatGPT request failed: ${error.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  } else if (req.url === "/log") {
    res.writeHead(200, { "Content-Type": "text/html" });
    const body = [...log]
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
             <div>Average request time: ${(totalRequestTime / requestCount).toFixed(1)}s</div>
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
    // This is a ChatGPT v1 API request
    // https://platform.openai.com/docs/api-reference/chat/create
    try {
      const started = new Date().getTime();
      const body = await getBody(req);

      //logInfo(`ChatGPT request text: ${body}`);

      const data = JSON.parse(body);

      const {
        security_key,
        openai_api_key,
        project,
        organization,
        timeout,
        ...create_chat_completion
      } = data;

      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      const openai = new OpenAI({
        apiKey: openai_api_key || (process.env.OPENAI_API_KEY as string),
        project: project ?? null,
        organization: organization ?? null,
      });

      let chatCompletion;

      try {
        currentParallelRequests++;

        if (currentParallelRequests > maxParallelRequests) {
          maxParallelRequests = currentParallelRequests;
        }

        chatCompletion = await openai.chat.completions.create(
          create_chat_completion,
        );
      } finally {
        currentParallelRequests--;
      }

      const chatCompletionText = JSON.stringify(chatCompletion, null, 2);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(chatCompletionText);

      const createChatCompletionText = JSON.stringify(
        create_chat_completion,
        null,
        2,
      );

      requestCount++;
      const requestTime = (new Date().getTime() - started) / 1000;
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
    } catch (error: any) {
      errorCount++;
      logError(`ChatGPT request failed: ${error.message}`);
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

      const started = new Date().getTime();
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
          (new Date().getTime() - started) /
          1000
        ).toFixed()}s...`,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gptResponse, null, 2));
    } catch (error: any) {
      logError(`ChatGPT request failed: ${error.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }

    // New Embeddings Endpoint
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

      const started = new Date().getTime();
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
          (new Date().getTime() - started) /
          1000
        ).toFixed()}s...`,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(embeddingsResponseText);
    } catch (error: any) {
      logError(`Embeddings request failed: ${error.message}`);
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
