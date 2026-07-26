/**
 * TDS Data-Analyst Telegram Bot
 * Runs on Cloudflare Workers (free tier).
 *
 * Flow:
 *  Telegram --webhook POST--> this Worker
 *    -> logs the incoming message to GitHub (logs/run.jsonl)
 *    -> searches the web (Tavily free tier), then asks Groq (free tier) to answer
 *    -> logs the answer
 *    -> replies on Telegram with the final JSON text
 */

export default {
  async fetch(request, env) {
    // Simple health check so you can confirm the Worker is alive in a browser
    if (request.method === "GET") {
      return new Response("Bot is running.");
    }

    if (request.method !== "POST") {
      return new Response("ok");
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("bad request", { status: 400 });
    }

    const message = update.message?.text;
    const chatId = update.message?.chat?.id;

    if (!message || !chatId) {
      // Not a text message (e.g. a sticker, join event) - ignore politely
      return new Response("ok");
    }

    try {
      await logEvent(env, { type: "received_message", chat_id: chatId, text: message });

      const answer = await runAgent(env, message);

      await sendTelegramMessage(env, chatId, answer);

      await logEvent(env, { type: "final_answer", chat_id: chatId, text: answer });
    } catch (err) {
      // Never let the Worker crash silently - log the error and tell the user something went wrong
      await logEvent(env, { type: "error", message: String(err && err.stack ? err.stack : err) });
      try {
        await sendTelegramMessage(env, chatId, JSON.stringify({ error: "internal_error" }));
      } catch (e2) {
        // swallow - nothing more we can do
      }
    }

    return new Response("ok");
  },
};

/* ---------------------------------------------------------------------- */
/* Agent: searches the web (Tavily), then asks Groq to reason over results  */
/* ---------------------------------------------------------------------- */

async function runAgent(env, userMessage) {
  // Step 1: search the web ourselves (Tavily free tier)
  const searchResults = await tavilySearch(env, userMessage);

  const systemPrompt = `You are a data-analysis agent answering questions about
public datasets (MOSPI and similar Indian government statistics, or general
public data). The user's message will tell you EXACTLY what JSON shape to
reply with. You have been given real web search results below - use them as
your source of truth. Rules you must follow:
1. Base your answer on the search results provided. Do not guess or fabricate
   numbers. If the search results are insufficient, use the most plausible
   figure you can find in them and note nothing extra - just answer.
2. Do the arithmetic/reasoning carefully.
3. Your FINAL reply must be ONLY the exact JSON object the question asks for.
   No markdown code fences, no explanation text, no extra keys unless asked.
4. If the question is a multi-turn conversation, answer only the LAST message,
   using earlier messages only as context.`;

  const userContent = `Question:\n${userMessage}\n\nWeb search results:\n${searchResults}`;

  // Step 2: reason over the search results using Groq (free tier, OpenAI-compatible)
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error("Empty response from Groq: " + JSON.stringify(data));
  }

  // Strip accidental markdown fences if the model adds them anyway
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
}

async function tavilySearch(env, query) {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: query,
        search_depth: "advanced",
        include_answer: true,
        max_results: 5,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return `(search failed: ${res.status} ${errText})`;
    }

    const data = await res.json();

    let combined = "";
    if (data.answer) {
      combined += `Quick answer: ${data.answer}\n\n`;
    }
    for (const r of data.results || []) {
      combined += `Source: ${r.title} (${r.url})\n${r.content}\n\n`;
    }
    return combined || "(no search results found)";
  } catch (err) {
    return `(search error: ${String(err)})`;
  }
}

/* ---------------------------------------------------------------------- */
/* Telegram helper                                                        */
/* ---------------------------------------------------------------------- */

async function sendTelegramMessage(env, chatId, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram sendMessage error: ${res.status} ${errText}`);
  }
}

/* ---------------------------------------------------------------------- */
/* Logging: append a JSON line to logs/run.jsonl in your GitHub repo       */
/* ---------------------------------------------------------------------- */

async function logEvent(env, event) {
  event.ts = new Date().toISOString();
  const newLine = JSON.stringify(event) + "\n";

  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.GITHUB_LOG_PATH}`;

  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. Get current file (if it exists) to read its sha + content
    let sha = undefined;
    let existingContent = "";

    const getRes = await fetch(apiUrl + `?ref=${env.GITHUB_BRANCH || "main"}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "tds-telegram-bot",
        Accept: "application/vnd.github+json",
      },
    });

    if (getRes.status === 200) {
      const fileData = await getRes.json();
      sha = fileData.sha;
      existingContent = decodeBase64(fileData.content.replace(/\n/g, ""));
    } else if (getRes.status !== 404) {
      console.log("GitHub GET error", getRes.status, await getRes.text());
    }

    const updatedContent = existingContent + newLine;

    // 2. Push the updated content back
    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "tds-telegram-bot",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `log: ${event.type} ${event.ts}`,
        content: encodeBase64(updatedContent),
        branch: env.GITHUB_BRANCH || "main",
        ...(sha ? { sha } : {}),
      }),
    });

    if (putRes.ok) {
      return; // success
    }

    const bodyText = await putRes.text();

    if (putRes.status === 409 && attempt < maxAttempts) {
      // Someone else updated the file between our GET and PUT (race condition).
      // Wait a moment, then loop around and try again with a fresh sha.
      console.log(`GitHub PUT 409 conflict, retrying (attempt ${attempt})`, bodyText);
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      continue;
    }

    console.log("GitHub PUT error", putRes.status, bodyText);
    return;
  }
}

function encodeBase64(str) {
  // Workers support btoa, but it only handles latin1 - encode UTF-8 safely
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
