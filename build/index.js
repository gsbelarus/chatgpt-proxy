import http from "http";
import { config } from "dotenv";
import OpenAI from "openai";
config({ path: [ ".env.local", ".env" ] });
const log = [];
function logError(message) {
  log.push({ type: "ERROR", message, timestamp: new Date() });
  log.splice(0, log.length - 100);
}
function logInfo(message) {
  log.push({ type: "INFO", message, timestamp: new Date() });
  log.splice(0, log.length - 100);
}
const { ChatGPTAPI } = await import("chatgpt");
function getBody(request) {
  return new Promise((resolve) => {
    const bodyParts = [];
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
function isChatGPTRequest(object) {
  return (typeof object === "object" &&
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
        object.top_p <= 1)));
}
export const server = http.createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow all origins
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); // Allow specific methods
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept"); // Allow specific headers
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Hello, World!</h1>");
  }
  else if (req.url === "/health") {
    try {
      const chatAPI = new ChatGPTAPI({
        apiKey: process.env.OPENAI_API_KEY,
        apiBaseUrl: "https://api.openai.com/v1",
        completionParams: {
          model: "gpt-3.5-turbo",
          temperature: 1,
        },
      });
      const gptResponse = await chatAPI.sendMessage("Who are you?", {
        systemMessage: `You are an AI assistant.`,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gptResponse, null, 2));
    }
    catch (error) {
      logError(`ChatGPT request failed: ${error.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
  else if (req.url === "/health2") {
    try {
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      const chatCompletion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
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
    }
    catch (error) {
      logError(`ChatGPT request failed: ${error.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
  else if (req.url === "/log") {
    res.writeHead(200, { "Content-Type": "text/html" });
    const body = [ ...log ]
      .reverse()
      .map((entry) => `<p><strong>${entry.timestamp.toISOString()} [${entry.type}]</strong> ${entry.message}</p>`)
      .join("");
    res.end(`<html><meta charset="UTF-8"><body><pre>${body}</pre></body></html>`);
  }
  else if (req.url === "/openai" && req.method === "POST") {
    // This is a ChatGPT v1 API request
    // https://platform.openai.com/docs/api-reference/chat/create
    try {
      const body = await getBody(req);
      logInfo(`ChatGPT request text: ${body}`);
      const data = JSON.parse(body);
      const { security_key, ...create_chat_completion } = data;
      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      const started = new Date().getTime();
      logInfo(`ChatGPT request: ${JSON.stringify(create_chat_completion, null, 2)}`);
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      const chatCompletion = await openai.chat.completions.create(create_chat_completion);
      const chatCompletionText = JSON.stringify(chatCompletion, null, 2);
      logInfo(`ChatGPT response: ${chatCompletionText}`);
      logInfo(`ChatGPT request successful in ${((new Date().getTime() - started) / 1000).toFixed()}s...`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(chatCompletionText);
    }
    catch (error) {
      logError(`ChatGPT request failed: ${error.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
  else if (req.url === "/chatgpt" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const data = JSON.parse(body);
      if (!isChatGPTRequest(data)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request");
        return;
      }
      const { prompt, model, temperature, top_p, max_tokens, security_key } = data;
      if (security_key !== process.env.SECURITY_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      const started = new Date().getTime();
      logInfo(`ChatGPT request: ${prompt}`);
      const chatAPI = new ChatGPTAPI({
        apiKey: process.env.OPENAI_API_KEY,
        apiBaseUrl: "https://api.openai.com/v1",
        completionParams: {
          model: model ?? "gpt-4o",
          temperature: temperature ?? 1,
          top_p: top_p ?? 1,
          max_tokens,
        },
      });
      const gptResponse = await chatAPI.sendMessage(prompt, {
        systemMessage: `You are an AI assistant.`,
      });
      logInfo(`ChatGPT request successful in ${((new Date().getTime() - started) / 1000).toFixed()}s...`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gptResponse, null, 2));
    }
    catch (error) {
      logError(`ChatGPT request failed: ${error.message}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
  else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});
const port = 3002;
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}/`);
});
//# sourceMappingURL=index.js.map