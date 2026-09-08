require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

const stringSession = new StringSession(
    process.env.TELEGRAM_SESSION || ""
);

const client = new TelegramClient(
    stringSession,
    apiId,
    apiHash,
    {
        connectionRetries: 10,
        requestRetries: 5,
        autoReconnect: true,
    }
);

async function getTelegramClient() {
    if (!client.connected) {
        await client.connect();
    }

    return client;
}

module.exports = {
    getTelegramClient,
};
