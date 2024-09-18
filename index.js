import lark from "@larksuiteoapi/node-sdk";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

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

// Function to process commands
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
  text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>"); // **bold**
  text = text.replace(/\*(.*?)\*/g, "<i>$1</i>"); // *italic*
  return text;
}

// Function to reply to a message in Lark
async function reply(messageId, content, msgType = "text") {
  try {
    const formattedContent = formatMarkdown(content);
    return await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: formattedContent }),
        msg_type: msgType,
      },
    });
  } catch (e) {
    const errorCode = e?.response?.data?.code;
    if (errorCode === 230002) {
      logger("Bot/User is not in the chat anymore", e, messageId, content);
    } else {
      logger("Error sending message to Lark", e, messageId, content);
    }
  }
}

// Function to upload an image to Lark
async function uploadImage(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const response = await client.im.image.create({
      data: {
        image_type: "message",
        image: fs.createReadStream(filePath),
      },
    });

    return response.data.image_key; // Return the image key from Lark
  } catch (error) {
    logger("Error uploading image to Lark", error);
    throw error;
  }
}

// Reply with an image
async function replyWithImage(messageId, imageKey) {
  return await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ image_key: imageKey }),
      msg_type: "image",
    },
  });
}

// Help command
async function cmdHelp(messageId) {
  const helpText = `
  Lark GPT Commands:
  - /clear : Remove conversation history to start a new session.
  - /help : Get more help messages.
  `;
  await reply(messageId, helpText, "Help");
}

// Clear conversation history command
async function cmdClear(sessionId, messageId) {
  conversationHistories.delete(sessionId);
  await reply(messageId, "✅ Conversation history cleared.");
}

// Query the Flowise API
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

    if (result.text) {
      history.push(result.text);
      conversationHistories.set(sessionId, history);
      return result.text;
    }

    throw new Error("Invalid response from Flowise API");
  } catch (error) {
    logger("Error querying Flowise API:", error);
    throw error;
  }
}

// Function to handle reply and detect if it involves image generation
async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("Received question:", question);

  if (question.startsWith("/")) {
    return await cmdProcess({ action: question, sessionId, messageId });
  }

  try {
    const answer = await queryFlowise(question, sessionId);

    // Check if the question is related to generating a chart or image
    if (
      question.toLowerCase().includes("histogram") ||
      question.toLowerCase().includes("chart")
    ) {
      const filePath = "/tmp/work_hours_histogram.png"; // Assume the image is generated here

      // Log the file path for debugging
      console.log("Attempting to upload file:", filePath);

      // Check if file exists and upload the image
      const imageKey = await uploadImage(filePath);

      if (imageKey) {
        // Reply with the image
        return await replyWithImage(messageId, imageKey);
      } else {
        // If something goes wrong, send the text response
        return await reply(messageId, answer);
      }
    }

    // Otherwise, send the text answer
    return await reply(messageId, answer);
  } catch (error) {
    return await reply(
      messageId,
      "⚠️ An error occurred while processing your request."
    );
  }
}

// Validate Lark app configuration
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

// Webhook handler
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

// Hello World route
app.get("/hello", (req, res) => {
  res.json({ message: "Hello, World!" });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
