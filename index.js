import lark from "@larksuiteoapi/node-sdk";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const LARK_APP_ID = process.env.LARK_APP_ID || "";
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || "";
const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

app.use(express.json());

const conversationHistories = new Map();

function logger(...params) {
  console.error(`[CF]`, ...params);
}

async function cmdProcess({ action, sessionId, messageId }) {
  switch (action) {
    case "/help":
      return await cmdHelp(messageId);
    case "/clear":
      return await cmdClear(sessionId, messageId);
    default:
      return await cmdHelp(messageId);
  }
}

function formatMarkdown(text) {
  // Replace **bold** with <strong>bold</strong>
  text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
  // Replace *italic* with <em>italic</em>
  text = text.replace(/\*(.*?)\*/g, "<i>$1</i>");
  return text;
}

async function reply(messageId, content, artifacts = [], msgType = "text") {
  try {
    const formattedContent = formatMarkdown(content);

    // Send the text response
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({
          text: formattedContent,
        }),
        msg_type: msgType,
      },
    });

    // Check and send artifacts if available (e.g., PNG files)
    for (const artifact of artifacts) {
      if (artifact.type === "png") {
        await client.im.message.reply({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify({
              image_key: artifact.data, // Assuming this is the image key returned by Flowise
            }),
            msg_type: "image",
          },
        });
      }
    }
  } catch (e) {
    const errorCode = e?.response?.data?.code;
    if (errorCode === 230002) {
      logger("Bot/User is not in the chat anymore", e, messageId, content);
    } else {
      logger("Error sending message to Lark", e, messageId, content);
    }
  }
}

async function cmdHelp(messageId) {
  const helpText = `
  Lark GPT Commands

  Usage:
  - /clear : Remove conversation history to start a new session.
  - /help : Get more help messages.
  `;
  await reply(messageId, helpText, "Help");
}

async function cmdClear(sessionId, messageId) {
  conversationHistories.delete(sessionId); // Clear session history
  await reply(messageId, "✅ Conversation history cleared.");
}

async function queryFlowise(question, sessionId) {
  const history = conversationHistories.get(sessionId) || [];
  history.push(question);
  conversationHistories.set(sessionId, history);

  try {
    const response = await fetch(FLOWISE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: history.join(" ") }),
    });
    const result = await response.json();

    // Log the full response from Flowise
    console.log("Flowise API response:", result);

    if (result.text) {
      history.push(result.text);
      conversationHistories.set(sessionId, history);
      return result;
    }

    throw new Error("Invalid response from Flowise API");
  } catch (error) {
    logger("Error querying Flowise API:", error);
    throw error;
  }
}

async function handleReply(userInput, sessionId, messageId) {
  console.log("User input received:", userInput); // Log the entire userInput object

  // Check if `userInput.text` exists and handle the case where it's missing
  const question = userInput.text
    ? userInput.text.replace("@_user_1", "").trim()
    : null;

  if (!question) {
    return await reply(
      messageId,
      "⚠️ Invalid input received. Please provide a valid question."
    );
  }

  logger("Received question:", question);

  if (question.startsWith("/")) {
    return await cmdProcess({ action: question, sessionId, messageId });
  }

  try {
    const flowiseResponse = await queryFlowise(question, sessionId);

    // Extract text and artifacts from the response
    const { text, artifacts = [] } = flowiseResponse;
    return await reply(messageId, text, artifacts);
  } catch (error) {
    return await reply(
      messageId,
      "⚠️ An error occurred while processing your request."
    );
  }
}

async function validateAppConfig() {
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return { code: 1, message: "Missing Lark App ID or Secret" };
  }
  if (!LARK_APP_ID.startsWith("cli_")) {
    return { code: 1, message: "Lark App ID must start with 'cli_'" };
  }
  return { code: 0, message: "✅ Lark App configuration is valid." };
}

const processedEvents = new Set();

app.post("/webhook", async (req, res) => {
  const { body: params } = req;

  if (params.type === "url_verification") {
    return res.json({ challenge: params.challenge });
  }

  if (params.encrypt) {
    return res.json({
      code: 1,
      message: "Encryption is enabled, please disable it.",
    });
  }

  if (!params.header) {
    const configValidation = await validateAppConfig();
    return res.json(configValidation);
  }

  const { event_type: eventType, event_id: eventId } = params.header;

  if (eventType === "im.message.receive_v1") {
    const {
      message_id: messageId,
      chat_id: chatId,
      message_type: messageType,
    } = params.event.message;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = `${chatId}${senderId}`;

    if (processedEvents.has(eventId)) {
      return res.json({ code: 0, message: "Duplicate event" });
    }

    processedEvents.add(eventId);

    if (messageType !== "text") {
      await reply(messageId, "Only text messages are supported.");
      return res.json({ code: 0 });
    }

    const userInput = JSON.parse(params.event.message.content);
    const result = await handleReply(userInput, sessionId, messageId);
    return res.json(result);
  }

  return res.json({ code: 2 });
});

app.get("/hello", (req, res) => {
  res.json({ message: "Hello, World!" });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
