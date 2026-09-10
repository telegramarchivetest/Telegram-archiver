require("dotenv").config();

const mongoose = require("mongoose");

const {
    getTelegramClient,
} = require("./telegram");

const {
    connectToDatabase,
} = require("./database/mongodb");

const Chat =
    require("./database/models/Chat");

const Message =
    require("./database/models/Message");


const MESSAGE_BATCH_SIZE = Math.min(
    Number(process.env.MESSAGE_BATCH_SIZE || 100),
    100
);

const MAX_RETRIES = Number(
    process.env.MESSAGE_MAX_RETRIES || 5
);

const RETRY_DELAY_MS = Number(
    process.env.MESSAGE_RETRY_DELAY_MS || 3000
);

const MAX_MEDIA_SIZE =
    10 * 1024 * 1024;


const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });


function getMessageDate(message) {
    if (!message?.date) {
        return null;
    }

    return new Date(
        Number(message.date) * 1000
    );
}


function isWebm(message) {
    const fileName =
        message?.media?.document?.attributes?.find(
            (attribute) =>
                attribute?.className ===
                "DocumentAttributeFilename"
        )?.fileName || "";

    const mimeType =
        message?.media?.document?.mimeType || "";

    return (
        mimeType.toLowerCase() ===
            "video/webm" ||
        fileName
            .toLowerCase()
            .endsWith(".webm")
    );
}


function isSticker(message) {
    return Boolean(
        message?.media?.document?.attributes?.some(
            (attribute) =>
                attribute?.className ===
                "DocumentAttributeSticker"
        )
    );
}


function isAnimation(message) {
    return Boolean(
        message?.media?.document?.attributes?.some(
            (attribute) =>
                attribute?.className ===
                "DocumentAttributeAnimated"
        )
    );
}


function getDocumentSize(message) {
    const document =
        message?.media?.document;

    if (!document?.size) {
        return null;
    }

    return Number(document.size);
}


function getPhotoSize(message) {
    const sizes =
        message?.media?.photo?.sizes;

    if (
        !Array.isArray(sizes) ||
        sizes.length === 0
    ) {
        return null;
    }

    let maxSize = 0;

    for (const size of sizes) {
        if (
            size?.className ===
            "PhotoSize"
        ) {
            maxSize = Math.max(
                maxSize,
                Number(size.size || 0)
            );
        }

        if (
            size?.className ===
            "PhotoCachedSize"
        ) {
            maxSize = Math.max(
                maxSize,
                Number(
                    size.bytes?.length || 0
                )
            );
        }
    }

    return maxSize || null;
}


function getMediaInfo(message) {
    if (!message?.media) {
        return {
            type: null,
            size: null,
            mimeType: null,
            status: "skipped",
            reason: "no-media",
        };
    }

    if (isSticker(message)) {
        return {
            type: null,
            size: null,
            mimeType: null,
            status: "skipped",
            reason: "sticker",
        };
    }

    if (isAnimation(message)) {
        return {
            type: null,
            size: null,
            mimeType: null,
            status: "skipped",
            reason: "animation",
        };
    }

    if (isWebm(message)) {
        return {
            type: null,
            size: getDocumentSize(message),
            mimeType: "video/webm",
            status: "skipped",
            reason: "webm",
        };
    }

    if (message.media?.photo) {
        const size =
            getPhotoSize(message);

        if (
            size &&
            size > MAX_MEDIA_SIZE
        ) {
            return {
                type: "photo",
                size,
                mimeType: "image/jpeg",
                status: "skipped",
                reason: "large",
            };
        }

        return {
            type: "photo",
            size,
            mimeType: "image/jpeg",
            status: "pending",
            reason: null,
        };
    }

    if (message.media?.document) {
        const document =
            message.media.document;

        const size =
            getDocumentSize(message);

        const mimeType =
            document.mimeType || null;

        const isVoice =
            document.attributes?.some(
                (attribute) =>
                    attribute?.className ===
                        "DocumentAttributeAudio" &&
                    attribute?.voice === true
            ) || false;

        const isVideo =
            mimeType?.startsWith(
                "video/"
            ) ||
            document.attributes?.some(
                (attribute) =>
                    attribute?.className ===
                    "DocumentAttributeVideo"
            );

        if (
            size &&
            size > MAX_MEDIA_SIZE
        ) {
            return {
                type: isVoice
                    ? "voice"
                    : isVideo
                        ? "video"
                        : null,
                size,
                mimeType,
                status: "skipped",
                reason: "large",
            };
        }

        if (isVoice) {
            return {
                type: "voice",
                size,
                mimeType,
                status: "pending",
                reason: null,
            };
        }

        if (isVideo) {
            return {
                type: "video",
                size,
                mimeType,
                status: "pending",
                reason: null,
            };
        }
    }

    return {
        type: null,
        size: null,
        mimeType: null,
        status: "skipped",
        reason: "unsupported",
    };
}


function getSenderId(
    message,
    fallbackChatId
) {
    if (
        message?.senderId !== undefined &&
        message?.senderId !== null
    ) {
        return String(message.senderId);
    }

    if (
        message?.fromId?.userId !== undefined
    ) {
        return String(
            message.fromId.userId
        );
    }

    if (
        message?.fromId?.channelId !== undefined
    ) {
        return String(
            message.fromId.channelId
        );
    }

    if (
        message?.fromId?.chatId !== undefined
    ) {
        return String(
            message.fromId.chatId
        );
    }

    return String(fallbackChatId);
}


function buildMessageDocument(
    message,
    chatId,
    meId
) {
    const date =
        getMessageDate(message);

    if (!date) {
        return null;
    }

    const mediaInfo =
        getMediaInfo(message);

    const senderId =
        getSenderId(
            message,
            chatId
        );

    return {
        telegramId: Number(message.id),

        chatId: String(chatId),

        senderId,

        text:
            message.message || "",

        date,

        outgoing: Boolean(
            message.out === true ||
            String(senderId) ===
                String(meId)
        ),

        media: {
            type:
                mediaInfo.type,

            storageKey:
                null,

            mimeType:
                mediaInfo.mimeType,

            size:
                mediaInfo.size,

            status:
                mediaInfo.status,
        },
    };
}


/**
 * Save messages without overwriting
 * existing documents.
 *
 * Existing messages are left untouched.
 * New messages are inserted.
 */
async function saveMessages(
    messages,
    chatId,
    meId
) {
    const operations = [];

    let skipped = 0;
    let webm = 0;
    let stickers = 0;
    let animations = 0;
    let large = 0;
    let media = 0;

    for (const message of messages) {
        if (!message?.id) {
            skipped++;
            continue;
        }

        const document =
            buildMessageDocument(
                message,
                chatId,
                meId
            );

        if (!document) {
            skipped++;
            continue;
        }

        const mediaInfo =
            getMediaInfo(message);

        if (mediaInfo.type) {
            media++;
        }

        if (
            mediaInfo.reason ===
            "webm"
        ) {
            webm++;
        }

        if (
            mediaInfo.reason ===
            "sticker"
        ) {
            stickers++;
        }

        if (
            mediaInfo.reason ===
            "animation"
        ) {
            animations++;
        }

        if (
            mediaInfo.reason ===
            "large"
        ) {
            large++;
        }

        operations.push({
            updateOne: {
                filter: {
                    chatId:
                        String(chatId),

                    telegramId:
                        Number(message.id),
                },

                update: {
                    $setOnInsert:
                        document,
                },

                upsert: true,
            },
        });
    }

    if (
        operations.length === 0
    ) {
        return {
            inserted: 0,
            existing: 0,
            media,
            webm,
            stickers,
            animations,
            large,
            skipped,
        };
    }

    const result =
        await Message.bulkWrite(
            operations,
            {
                ordered: false,
            }
        );

    const inserted =
        Number(
            result.upsertedCount || 0
        );

    return {
        inserted,

        existing:
            operations.length -
            inserted,

        media,
        webm,
        stickers,
        animations,
        large,
        skipped,
    };
}


/**
 * Get oldest and newest stored
 * message for a chat.
 */
async function getChatMessageState(
    chatId
) {
    const [
        oldest,
        newest,
    ] = await Promise.all([
        Message.findOne({
            chatId: String(chatId),
        })
            .sort({
                date: 1,
            })
            .select({
                telegramId: 1,
                date: 1,
            })
            .lean(),

        Message.findOne({
            chatId: String(chatId),
        })
            .sort({
                telegramId: -1,
            })
            .select({
                telegramId: 1,
                date: 1,
            })
            .lean(),
    ]);

    return {
        oldest,
        newest,
    };
}


/**
 * Fetch one batch with retry.
 */
async function getMessagesWithRetry(
    client,
    entity,
    options
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        try {
            return await client.getMessages(
                entity,
                options
            );
        } catch (error) {
            lastError = error;

            if (
                attempt >= MAX_RETRIES
            ) {
                break;
            }

            await sleep(
                RETRY_DELAY_MS *
                attempt
            );
        }
    }

    throw lastError;
}


/**
 * Initialize a brand-new chat
 * without downloading its old history.
 *
 * If MongoDB has no message for this
 * chat and the cursor is also empty,
 * the latest Telegram message becomes
 * the starting point.
 *
 * This prevents a newly discovered
 * chat from causing a full historical
 * download.
 */
async function initializeNewChatCursor(
    client,
    entity,
    chat
) {
    const messages =
        await getMessagesWithRetry(
            client,
            entity,
            {
                limit: 1,
            }
        );

    if (!messages?.length) {
        return 0;
    }

    const latestMessageId =
        Number(
            messages[0]?.id || 0
        );

    if (
        !Number.isFinite(
            latestMessageId
        ) ||
        latestMessageId <= 0
    ) {
        return 0;
    }

    await Chat.updateOne(
        {
            _id: chat._id,
        },
        {
            $max: {
                lastArchivedMessageId:
                    latestMessageId,
            },
        }
    );

    return latestMessageId;
}


/**
 * Archive only messages that are
 * newer than the newest message
 * already stored in MongoDB.
 *
 * No historical backfill is performed.
 */
async function archiveNewMessages(
    client,
    entity,
    chat,
    meId
) {
    const state =
        await getChatMessageState(
            chat.telegramId
        );

    const mongoNewestId =
        Number(
            state.newest?.telegramId || 0
        );

    const cursorId =
        Number(
            chat.lastArchivedMessageId || 0
        );

    /**
     * Brand-new chat:
     *
     * Do NOT download the entire
     * Telegram history.
     *
     * Just establish the current
     * latest message as the baseline.
     */
    if (
        mongoNewestId <= 0 &&
        cursorId <= 0
    ) {
        await initializeNewChatCursor(
            client,
            entity,
            chat
        );

        return {
            inserted: 0,
            existing: 0,
            media: 0,
            webm: 0,
            stickers: 0,
            animations: 0,
            large: 0,
        };
    }

    /**
     * MongoDB is the source of truth
     * whenever messages already exist.
     *
     * The cursor is only a progress
     * marker and must never make us
     * skip messages.
     */
    const minId =
        mongoNewestId;

    let offsetId = 0;

    let inserted = 0;
    let existing = 0;
    let media = 0;
    let webm = 0;
    let stickers = 0;
    let animations = 0;
    let large = 0;

    let newestSeenId =
        mongoNewestId;

    while (true) {
        const messages =
            await getMessagesWithRetry(
                client,
                entity,
                {
                    limit:
                        MESSAGE_BATCH_SIZE,

                    minId,

                    offsetId,
                }
            );

        if (
            !messages?.length
        ) {
            break;
        }

        const result =
            await saveMessages(
                messages,
                chat.telegramId,
                meId
            );

        inserted +=
            result.inserted;

        existing +=
            result.existing;

        media +=
            result.media;

        webm +=
            result.webm;

        stickers +=
            result.stickers;

        animations +=
            result.animations;

        large +=
            result.large;

        for (
            const message
            of messages
        ) {
            const id =
                Number(message.id);

            if (
                id > newestSeenId
            ) {
                newestSeenId = id;
            }
        }

        /**
         * Telegram returns messages
         * newest -> oldest.
         *
         * Therefore the last message
         * is the oldest message of
         * this batch.
         */
        const oldestMessage =
            messages[
                messages.length - 1
            ];

        const nextOffsetId =
            Number(
                oldestMessage?.id
            );

        if (
            !Number.isFinite(
                nextOffsetId
            ) ||
            nextOffsetId <= 0
        ) {
            break;
        }

        /**
         * Safety guard against a
         * pagination loop.
         */
        if (
            offsetId !== 0 &&
            nextOffsetId >=
                offsetId
        ) {
            break;
        }

        offsetId =
            nextOffsetId;

        /**
         * Less than the requested
         * batch size means Telegram
         * has no more messages in
         * this range.
         */
        if (
            messages.length <
            MESSAGE_BATCH_SIZE
        ) {
            break;
        }
    }

    /**
     * Update the cursor only after
     * the incremental archive has
     * finished successfully.
     *
     * The cursor can never move
     * backwards.
     */
    if (
        newestSeenId >
        cursorId
    ) {
        await Chat.updateOne(
            {
                _id: chat._id,
            },
            {
                $max: {
                    lastArchivedMessageId:
                        newestSeenId,
                },
            }
        );
    }

    return {
        inserted,
        existing,
        media,
        webm,
        stickers,
        animations,
        large,
    };
}


/**
 * Archive one chat.
 *
 * IMPORTANT:
 *
 * There is intentionally NO
 * historical archive here.
 */
async function archiveChat(
    client,
    entity,
    chat,
    meId
) {
    return await archiveNewMessages(
        client,
        entity,
        chat,
        meId
    );
}


async function main() {
    /**
     * mongodb.js exports:
     *
     * {
     *     connectToDatabase
     * }
     */
    await connectToDatabase();

    const client =
        await getTelegramClient();

    const me =
        await client.getMe();

    const meId =
        String(me.id);

    /**
     * Get Telegram dialogs once.
     */
    const dialogs =
        await client.getDialogs({});

    const privateDialogs =
        dialogs.filter(
            (dialog) => {
                const entity =
                    dialog.entity;

                return (
                    entity?.className ===
                        "User" &&
                    !entity.bot
                );
            }
        );

    /**
     * Build entity map.
     *
     * This also means this file
     * is safe even if
     * archive-chats.js was not
     * executed before it.
     */
    const entityMap =
        new Map();

    for (
        const dialog
        of privateDialogs
    ) {
        const entity =
            dialog.entity;

        entityMap.set(
            String(entity.id),
            entity
        );
    }

    /**
     * Sync Telegram chats into
     * MongoDB.
     *
     * IMPORTANT:
     *
     * lastArchivedMessageId is
     * initialized ONLY when the
     * chat is first created.
     */
    for (
        const entity
        of privateDialogs.map(
            (dialog) =>
                dialog.entity
        )
    ) {
        const telegramId =
            String(entity.id);

        const title =
            entity.id === me.id
                ? "Saved Messages"
                : [
                    entity.firstName,
                    entity.lastName,
                ]
                    .filter(Boolean)
                    .join(" ") ||
                  entity.username ||
                  telegramId;

        await Chat.updateOne(
            {
                telegramId,
            },
            {
                $set: {
                    title,

                    username:
                        entity.username ||
                        null,

                    firstName:
                        entity.firstName ||
                        null,

                    lastName:
                        entity.lastName ||
                        null,

                    type: "private",
                },

                $setOnInsert: {
                    lastArchivedMessageId:
                        0,
                },
            },
            {
                upsert: true,
            }
        );
    }

    const chats =
        await Chat.find({
            type: "private",
        }).lean();

    console.log(
        `Message archive | chats=${chats.length} mode=new-only`
    );

    let totalInserted = 0;
    let totalExisting = 0;
    let totalMedia = 0;

    let totalWebm = 0;
    let totalStickers = 0;
    let totalAnimations = 0;
    let totalLarge = 0;

    let failedChats = 0;

    for (
        const chat of chats
    ) {
        const entity =
            entityMap.get(
                String(
                    chat.telegramId
                )
            );

        /**
         * A private chat stored in
         * MongoDB but no longer
         * returned by Telegram
         * cannot be processed.
         */
        if (!entity) {
            failedChats++;

            console.error(
                `Chat failed | chat=${chat.telegramId} | Telegram entity not found`
            );

            continue;
        }

        try {
            const result =
                await archiveChat(
                    client,
                    entity,
                    chat,
                    meId
                );

            totalInserted +=
                result.inserted;

            totalExisting +=
                result.existing;

            totalMedia +=
                result.media;

            totalWebm +=
                result.webm;

            totalStickers +=
                result.stickers;

            totalAnimations +=
                result.animations;

            totalLarge +=
                result.large;
        } catch (error) {
            failedChats++;

            console.error(
                `Chat failed | chat=${chat.telegramId} | ${error.message}`
            );
        }
    }

    console.log(
        [
            "Message archive completed",

            `inserted=${totalInserted}`,

            `existing=${totalExisting}`,

            `media=${totalMedia}`,

            `webm=${totalWebm}`,

            `stickers=${totalStickers}`,

            `animations=${totalAnimations}`,

            `large=${totalLarge}`,

            `failedChats=${failedChats}`,
        ].join(" | ")
    );

    await client.disconnect();

    await mongoose.connection.close();

    /**
     * Railway / parent process
     * receives a failed exit code
     * only if a chat actually failed.
     */
    if (
        failedChats > 0
    ) {
        process.exitCode = 1;
    }
}


main().catch(
    async (error) => {
        console.error(
            `Message archive fatal | ${error.message}`
        );

        try {
            await mongoose.connection.close();
        } catch {}

        process.exitCode = 1;
    }
);
