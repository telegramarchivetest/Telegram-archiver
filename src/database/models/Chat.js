const mongoose = require("mongoose");

const chatSchema = new mongoose.Schema(
    {
        telegramId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },

        type: {
            type: String,
            enum: ["private"],
            default: "private",
        },

        title: {
            type: String,
            required: true,
        },

        username: {
            type: String,
            default: null,
        },

        firstName: {
            type: String,
            default: null,
        },

        lastName: {
            type: String,
            default: null,
        },

        /*
         * Last Telegram message ID that
         * has been processed for this chat.
         *
         * This prevents downloading the same
         * messages again on every execution.
         */
        lastArchivedMessageId: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
    }
);

const Chat =
    mongoose.models.Chat ||
    mongoose.model("Chat", chatSchema);

module.exports = Chat;