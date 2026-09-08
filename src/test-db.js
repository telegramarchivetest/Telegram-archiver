require("dotenv").config();

const mongoose = require("mongoose");

const {
    connectToDatabase,
} = require("./database/mongodb");

const Chat = require(
    "./database/models/Chat"
);

async function main() {
    await connectToDatabase();

    console.log("\nMongoDB information:");

    console.log(
        "Database:",
        mongoose.connection.name
    );

    console.log(
        "Host:",
        mongoose.connection.host
    );

    const chats = await Chat.find({}).lean();

    console.log(
        `\nChats in database: ${chats.length}\n`
    );

    chats.forEach((chat, index) => {
        console.log(
            `${index + 1}. ${chat.title} | ${chat.telegramId}`
        );
    });

    await mongoose.disconnect();
}

main().catch((error) => {
    console.error(error);

    process.exit(1);
});
