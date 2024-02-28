import http from "http";
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });
const log = [];
function logError(message) {
    log.push({ type: "ERROR", message, timestamp: new Date() });
    log.splice(0, log.length - 10);
}
function logInfo(message) {
    log.push({ type: "INFO", message, timestamp: new Date() });
    log.splice(0, log.length - 10);
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
        "securityKey" in object &&
        typeof object.securityKey === "string" &&
        (object.role === undefined || typeof object.role === "string") &&
        (object.model === undefined || typeof object.model === "string") &&
        (object.schema === undefined || typeof object.schema === "string") &&
        (object.temperature === undefined ||
            (typeof object.temperature === "number" && object.temperature > 0)) &&
        (object.top_p === undefined ||
            (typeof object.top_p === "number" &&
                object.top_p >= 0 &&
                object.top_p <= 1)));
}
export const server = http.createServer(async (req, res) => {
    if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Hello, World!</h1>");
    }
    else if (req.url === "/log") {
        res.writeHead(200, { "Content-Type": "text/html" });
        const body = log
            .map((entry) => `<p>${entry.timestamp.toISOString()} [${entry.type}] ${entry.message}</p>`)
            .join("");
        res.end(`<html><body>${body}</body></html>`);
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
            const { prompt, role, model, schema, temperature, top_p, max_tokens, securityKey, } = data;
            if (securityKey !== process.env.SECURITY_KEY) {
                res.writeHead(403, { "Content-Type": "text/plain" });
                res.end("Forbidden");
                return;
            }
            const chatAPI = new ChatGPTAPI({
                apiKey: process.env.OPENAI_API_KEY,
                apiBaseUrl: "https://api.openai.com/v1",
                completionParams: {
                    model: model ?? "gpt-3.5-turbo",
                    temperature: temperature ?? 0.5,
                    top_p: top_p ?? 0.5,
                    max_tokens,
                },
            });
            const gptResponse = await chatAPI.sendMessage(prompt, {
                systemMessage: schema
                    ? `You are a machine that only returns and replies with valid, iterable RFC8259 compliant JSON in your responses according to the schema: ${schema}.`
                    : role,
            });
            logInfo(`ChatGPT request: ${prompt}`);
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