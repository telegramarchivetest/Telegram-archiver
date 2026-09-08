const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
    {
        telegramId: {
            type: Number,
            required: true,
        },

        chatId: {
            type: String,
            required: true,
            index: true,
        },

        senderId: {
            type: String,
            required: true,
        },

        text: {
            type: String,
            default: "",
        },

        date: {
            type: Date,
            required: true,
            index: true,
        },

        outgoing: {
            type: Boolean,
            required: true,
        },

        media: {
            type: {
                type: String,
                enum: [
                    "photo",
                    "video",
                    "voice",
                ],
                default: null,
            },

            storageKey: {
                type: String,
                default: null,
            },

            mimeType: {
                type: String,
                default: null,
            },

            size: {
                type: Number,
                default: null,
            },

            status: {
                type: String,
                enum: [
                    "pending",
                    "uploading",
                    "uploaded",
                    "failed",
                    "skipped",
                ],
                default: "pending",
            },
        },
    },
    {
        timestamps: true,
    }
);


messageSchema.index(
    {
        chatId: 1,
        telegramId: 1,
    },
    {
        unique: true,
    }
);


const Message =
    mongoose.models.Message ||
    mongoose.model(
        "Message",
        messageSchema
    );


module.exports = Message;
