// Example: Free Best Router via the openai-node SDK (ESM).
//
// Run:
//   npm install openai
//   node chat.mjs

import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:4098/v1",
  apiKey: "not-validated", // the router does not validate the inbound bearer
});

async function nonStreaming() {
  const response = await client.chat.completions.create({
    model: "free-best",
    messages: [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: "What is the capital of France?" },
    ],
    max_tokens: 64,
  });
  console.log("=== non-streaming ===");
  console.log("picked model:", response.model);
  console.log("content:", response.choices[0].message.content);
}

async function streaming() {
  console.log("\n=== streaming ===");
  const stream = await client.chat.completions.create({
    model: "free-best",
    messages: [{ role: "user", content: "Write a haiku about open source." }],
    max_tokens: 64,
    stream: true,
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
  }
  process.stdout.write("\n");
}

await nonStreaming();
await streaming();
