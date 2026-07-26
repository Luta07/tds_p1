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

      const history = await getChatHistory(env, chatId);
      history.push(message);
      await saveChatHistory(env, chatId, history);

      let answer = await runAgent(env, history);
      answer = enforceLogUrl(env, answer);

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
function realLogUrl(env) {
  return `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH || "main"}/${env.GITHUB_LOG_PATH}`;
}

/* ---------------------------------------------------------------------- */
/* Chat history (KV) - lets the bot handle multi-turn conversations       */
/* ---------------------------------------------------------------------- */

const MAX_HISTORY_MESSAGES = 8;

async function getChatHistory(env, chatId) {
  try {
    const raw = await env.CHAT_HISTORY.get(`chat:${chatId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // If KV isn't set up yet, or something's malformed, just start fresh
    // rather than crashing the whole request.
    return [];
  }
}

async function saveChatHistory(env, chatId, history) {
  try {
    const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
    await env.CHAT_HISTORY.put(`chat:${chatId}`, JSON.stringify(trimmed));
  } catch (e) {
    // Don't let a KV write failure break the whole request - worst case we
    // just lose multi-turn memory for this chat, single-turn still works.
  }
}

// The model is unreliable about outputting the correct log_url (it sometimes
// invents one from a search result). We never trust the model for the VALUE
// of this field - but we also must not ADD a log_url key that the question
// never asked for, since grading is exact-match on the JSON shape requested.
function enforceLogUrl(env, modelText) {
  const trueUrl = realLogUrl(env);

  try {
    const parsed = JSON.parse(modelText);
    if (parsed && typeof parsed === "object" && "log_url" in parsed) {
      parsed.log_url = trueUrl;
      return JSON.stringify(parsed);
    }
    // No log_url key in the model's JSON - the question didn't ask for one,
    // so leave the object exactly as the model produced it.
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(parsed);
    }
  } catch (e) {
    // Not valid JSON - fall through to a regex-based patch below
  }

  // Fallback: if the model's output already contains a "log_url" key but
  // isn't valid JSON for some reason, patch just that value with regex.
  if (/"log_url"\s*:/.test(modelText)) {
    return modelText.replace(/"log_url"\s*:\s*"[^"]*"/, `"log_url": "${trueUrl}"`);
  }

  // Question didn't mention log_url at all - return as-is
  return modelText;
}

/* ---------------------------------------------------------------------- */
/* Agent: searches the web (Tavily), then asks Groq to reason over results  */
/* ---------------------------------------------------------------------- */

async function runAgent(env, chatHistory) {
  // chatHistory is an array of message strings in order, oldest first.
  // The LAST message is the one we must answer; earlier ones are context.
  const lastMessage = chatHistory[chatHistory.length - 1];
  const priorMessages = chatHistory.slice(0, -1);

  // Step 1: search the web ourselves (Tavily free tier), based on the
  // question we actually need to answer (the last message)
  const searchResults = await tavilySearch(env, lastMessage);

  const systemPrompt = `You are a data-analysis agent answering questions about
public datasets (MOSPI and similar Indian government statistics, or general
public data). Unless the question clearly says otherwise, assume it is asking
about India specifically (Indian states, Indian government data) - not the
US or any other country. This may be a multi-turn conversation: you will be
given any earlier messages as context, followed by the message you must
actually answer. Only answer the LAST message; use earlier messages purely
for context (e.g. clarifying which dataset or topic is meant).
The last message will tell you EXACTLY what JSON shape to reply with. You
have been given real web search results below - use them as your source of
truth. Rules you must follow:
1. Base your answer on the search results provided. Do not guess or fabricate
   numbers. If the search results are insufficient, use the most plausible
   figure you can find in them and note nothing extra - just answer.
2. Do the arithmetic/reasoning carefully.
3. Your FINAL reply must be ONLY the exact JSON object the LAST message asks
   for. No markdown code fences, no explanation text, no extra keys unless
   asked.
4. For any "log_url" field the question asks for, just put the placeholder
   string "PLACEHOLDER" - it will be replaced automatically, so don't worry
   about finding a real URL for it.`;

  let userContent = "";
  if (priorMessages.length > 0) {
    userContent += `Earlier messages in this conversation (context only, do not answer these):\n`;
    priorMessages.forEach((m, i) => {
      userContent += `${i + 1}. ${m}\n`;
    });
    userContent += `\n`;
  }
  userContent += `Message to answer:\n${lastMessage}\n\nWeb search results:\n${searchResults}`;

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
  // If the question is about India / MOSPI, steer the search toward Indian
  // government sources so we don't accidentally get US-specific results
  // (e.g. "maternal mortality by state" defaulting to US state rankings).
  const isIndiaRelated = /india|mospi|state\b/i.test(query);
  const searchQuery = isIndiaRelated
    ? `${query} India government official statistics site:mospi.gov.in OR site:data.gov.in OR site:pib.gov.in OR India`
    : query;

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: searchQuery,
        search_depth: "advanced",
        include_answer: true,
        max_results: 6,
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
