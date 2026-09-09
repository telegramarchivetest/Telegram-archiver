require("dotenv").config();

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


/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const INITIAL_ARCHIVE_DAYS =
    Math.max(
        1,
        Number(
            process.env.INITIAL_ARCHIVE_DAYS || 730
        )
    );

const BATCH_SIZE =
    Math.max(
        1,
        Number(
            process.env.MESSAGE_BATCH_SIZE || 100
        )
    );

const MAX_RETRIES = 5;

const RETRY_DELAY = 3000;

const MAX_MEDIA_SIZE =
    10 * 1024 * 1024;


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function sleep(ms) {
    return new Promise((resolve) =>
        setTimeout(resolve, ms)
    );
}


function getHistoryStartDate() {
    const date =
        new Date();

    date.setDate(
        date.getDate() -
        INITIAL_ARCHIVE_DAYS
    );

    return date;
}


function getMessageDate(message) {
    if (!message?.date) {
        return null;
    }

    /*
     * GramJS normally returns
     * Unix timestamp in seconds.
     */
    if (
        typeof message.date ===
        "number"
    ) {
        return new Date(
            message.date * 1000
        );
    }

    if (
        message.date instanceof Date
    ) {
        return message.date;
    }

    const date =
        new Date(message.date);

    return Number.isNaN(
        date.getTime()
    )
        ? null
        : date;
}


/*
|--------------------------------------------------------------------------
| WebM detection
|--------------------------------------------------------------------------
*/

function isWebM(message) {
    const document =
        message?.document;

    if (!document) {
        return false;
    }

    /*
     * MIME type
     */
    const mimeType =
        String(
            document.mimeType || ""
        ).toLowerCase();

    if (
        mimeType === "video/webm" ||
        mimeType === "image/webm"
    ) {
        return true;
    }

    /*
     * Filename
     */
    const attributes =
        Array.isArray(
            document.attributes
        )
            ? document.attributes
            : [];

    for (const attribute of attributes) {
        const fileName =
            attribute?.fileName;

        if (
            typeof fileName ===
                "string" &&
            fileName
                .toLowerCase()
                .endsWith(".webm")
        ) {
            return true;
        }
    }

    return false;
}


/*
|--------------------------------------------------------------------------
| Telegram document helpers
|--------------------------------------------------------------------------
*/

function getDocumentAttributes(message) {
    if (
        !message?.document ||
        !Array.isArray(
            message.document.attributes
        )
    ) {
        return [];
    }

    return message.document.attributes;
}


function isSticker(message) {
    const attributes =
        getDocumentAttributes(
            message
        );

    return attributes.some(
        (attribute) =>
            attribute.className ===
            "DocumentAttributeSticker"
    );
}


function isAnimation(message) {
    const attributes =
        getDocumentAttributes(
            message
        );

    return attributes.some(
        (attribute) =>
            attribute.className ===
            "DocumentAttributeAnimated"
    );
}


/*
|--------------------------------------------------------------------------
| Photo size
|--------------------------------------------------------------------------
*/

function getPhotoSize(photo) {
    if (
        !photo ||
        !Array.isArray(photo.sizes)
    ) {
        return null;
    }

    let largest = 0;

    for (const size of photo.sizes) {
        /*
         * Normal PhotoSize
         */
        if (
            typeof size.size ===
                "number" &&
            size.size > largest
        ) {
            largest = size.size;
        }

        /*
         * Progressive PhotoSize
         */
        if (
            Array.isArray(
                size.sizes
            ) &&
            size.sizes.length > 0
        ) {
            const progressive =
                Number(
                    size.sizes[
                        size.sizes.length - 1
                    ]
                );

            if (
                Number.isFinite(
                    progressive
                ) &&
                progressive > largest
            ) {
                largest =
                    progressive;
            }
        }
    }

    return largest > 0
        ? largest
        : null;
}


/*
|--------------------------------------------------------------------------
| Media information
|--------------------------------------------------------------------------
*/

function getMediaInfo(message) {
    /*
     * WebM
     */
    if (isWebM(message)) {
        return {
            media: null,
            reason: "webm",
        };
    }


    /*
     * Sticker
     */
    if (isSticker(message)) {
        return {
            media: null,
            reason: "sticker",
        };
    }


    /*
     * Animation / GIF
     */
    if (isAnimation(message)) {
        return {
            media: null,
            reason: "animation",
        };
    }


    /*
     * Photo
     */
    if (message.photo) {
        const size =
            getPhotoSize(
                message.photo
            );

        if (
            size !== null &&
            size > MAX_MEDIA_SIZE
        ) {
            return {
                media: null,
                reason: "too_large",
            };
        }

        return {
            media: {
                type: "photo",

                mimeType:
                    "image/jpeg",

                size,
            },

            reason: null,
        };
    }


    /*
     * Document
     */
    if (message.document) {
        const document =
            message.document;

        const mimeType =
            String(
                document.mimeType || ""
            ).toLowerCase();

        const size =
            Number(
                document.size || 0
            );


        /*
         * Voice
         */
        const attributes =
            getDocumentAttributes(
                message
            );

        const isVoice =
            attributes.some(
                (attribute) =>
                    attribute.className ===
                        "DocumentAttributeAudio" &&
                    attribute.voice === true
            );

        if (isVoice) {
            return {
                media: {
                    type: "voice",

                    mimeType:
                        mimeType ||
                        "audio/ogg",

                    size,
                },

                reason:
                    size > MAX_MEDIA_SIZE
                        ? "too_large"
                        : null,
            };
        }


        /*
         * Video
         */
        if (
            mimeType.startsWith(
                "video/"
            )
        ) {
            if (
                size >
                MAX_MEDIA_SIZE
            ) {
                return {
                    media: null,
                    reason: "too_large",
                };
            }

            return {
                media: {
                    type: "video",

                    mimeType,

                    size,
                },

                reason: null,
            };
        }
    }


    return {
        media: null,
        reason: null,
    };
}


/*
|--------------------------------------------------------------------------
| Telegram request with retry
|--------------------------------------------------------------------------
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
                attempt ===
                MAX_RETRIES
            ) {
                break;
            }

            await sleep(
                RETRY_DELAY
            );

            try {
                if (
                    !client.connected
                ) {
                    await client.connect();
                }
            } catch {
                // Ignore reconnect error.
            }
        }
    }

    throw lastError;
}


/*
|--------------------------------------------------------------------------
| Save messages
|--------------------------------------------------------------------------
|
| VERY IMPORTANT:
|
| We use:
|
| updateOne
| upsert: true
| $setOnInsert
|
| Existing messages are NOT modified.
|
*/

async function saveMessages(
    documents
) {
    if (
        !documents.length
    ) {
        return {
            inserted: 0,
            existing: 0,
        };
    }

    const operations =
        documents.map(
            (document) => ({
                updateOne: {
                    filter: {
                        chatId:
                            document.chatId,

                        telegramId:
                            document.telegramId,
                    },

                    update: {
                        $setOnInsert:
                            document,
                    },

                    upsert: true,
                },
            })
        );


    const result =
        await Message.bulkWrite(
            operations,
            {
                ordered: false,
            }
        );


    const inserted =
        Number(
            result.upsertedCount ||
            0
        );


    return {
        inserted,

        existing:
            documents.length -
            inserted,
    };
}


/*
|--------------------------------------------------------------------------
| Get MongoDB state for a chat
|--------------------------------------------------------------------------
*/

async function getChatMessageState(
    chatId
) {
    /*
     * Oldest stored message.
     */
    const oldest =
        await Message.findOne({
            chatId,
        })
            .sort({
                date: 1,
            })
            .select({
                date: 1,
                telegramId: 1,
            })
            .lean();


    /*
     * Newest stored message.
     */
    const newest =
        await Message.findOne({
            chatId,
        })
            .sort({
                telegramId: -1,
            })
            .select({
                date: 1,
                telegramId: 1,
            })
            .lean();


    return {
        oldest,
        newest,
    };
}


/*
|--------------------------------------------------------------------------
| Build MongoDB message document
|--------------------------------------------------------------------------
*/

function buildMessageDocument(
    message,
    chatId,
    media
) {
    const date =
        getMessageDate(
            message
        );

    if (!date) {
        return null;
    }

    const telegramId =
        Number(
            message.id
        );

    if (
        !Number.isFinite(
            telegramId
        )
    ) {
        return null;
    }

    return {
        telegramId,

        chatId:
            String(chatId),

        senderId:
            message.senderId
                ?.toString() ||
            String(chatId),

        text:
            message.message ||
            "",

        date,

        outgoing:
            Boolean(
                message.out
            ),

        media:
            media
                ? {
                    type:
                        media.type,

                    storageKey:
                        null,

                    mimeType:
                        media.mimeType,

                    size:
                        media.size,

                    status:
                        "pending",
                }
                : {
                    type:
                        null,

                    storageKey:
                        null,

                    mimeType:
                        null,

                    size:
                        null,

                    status:
                        null,
                },
    };
}


/*
|--------------------------------------------------------------------------
| Process Telegram messages
|--------------------------------------------------------------------------
*/

async function processMessages(
    messages,
    chatId,
    stats
) {
    if (
        !messages ||
        !messages.length
    ) {
        return;
    }


    const documents = [];


    for (
        const message of messages
    ) {
        if (
            !message?.id ||
            !message?.date
        ) {
            continue;
        }


        /*
         * WebM
         */
        if (
            isWebM(message)
        ) {
            stats.webm++;
            continue;
        }


        const mediaResult =
            getMediaInfo(
                message
            );


        if (
            mediaResult.reason ===
            "sticker"
        ) {
            stats.stickers++;
            continue;
        }


        if (
            mediaResult.reason ===
            "animation"
        ) {
            stats.animations++;
            continue;
        }


        if (
            mediaResult.reason ===
            "too_large"
        ) {
            stats.large++;
            continue;
        }


        const document =
            buildMessageDocument(
                message,
                chatId,
                mediaResult.media
            );


        if (!document) {
            continue;
        }


        documents.push(
            document
        );
    }


    if (
        !documents.length
    ) {
        return;
    }


    const result =
        await saveMessages(
            documents
        );


    stats.inserted +=
        result.inserted;

    stats.existing +=
        result.existing;

    stats.media +=
        documents.filter(
            (document) =>
                document.media &&
                document.media.type
        ).length;
}


/*
|--------------------------------------------------------------------------
| Archive new messages
|--------------------------------------------------------------------------
*/

async function archiveNewMessages(
    client,
    chat,
    entity,
    stats
) {
    const chatId =
        String(
            chat.telegramId
        );


    /*
     * IMPORTANT:
     *
     * Don't blindly trust lastArchivedMessageId.
     *
     * We also look at MongoDB and use the
     * actual newest message ID.
     */
    const state =
        await getChatMessageState(
            chatId
        );


    const storedNewestId =
        Number(
            state.newest?.telegramId ||
            0
        );


    const chatCursor =
        Number(
            chat.lastArchivedMessageId ||
            0
        );


    const minId =
        Math.max(
            storedNewestId,
            chatCursor
        );


    let offsetId = 0;

    let highestId =
        minId;


    while (true) {
        const options = {
            limit:
                BATCH_SIZE,

            minId,

            offsetId,
        };


        const messages =
            await getMessagesWithRetry(
                client,
                entity,
                options
            );


        if (
            !messages ||
            messages.length === 0
        ) {
            break;
        }


        await processMessages(
            messages,
            chatId,
            stats
        );


        for (
            const message of messages
        ) {
            const id =
                Number(
                    message.id
                );

            if (
                Number.isFinite(id) &&
                id > highestId
            ) {
                highestId = id;
            }
        }


        /*
         * Messages are returned newest -> oldest.
         *
         * Move to the oldest ID from
         * this batch for the next request.
         */
        const ids =
            messages
                .map(
                    (message) =>
                        Number(
                            message.id
                        )
                )
                .filter(
                    Number.isFinite
                );


        if (!ids.length) {
            break;
        }


        const oldestId =
            Math.min(...ids);


        /*
         * Safety check.
         */
        if (
            oldestId <= minId
        ) {
            break;
        }


        offsetId =
            oldestId;


        if (
            messages.length <
            BATCH_SIZE
        ) {
            break;
        }
    }


    /*
     * Update cursor only forward.
     */
    if (
        highestId >
        chatCursor
    ) {
        await Chat.updateOne(
            {
                _id:
                    chat._id,
            },
            {
                $set: {
                    lastArchivedMessageId:
                        highestId,
                },
            }
        );
    }
}


/*
|--------------------------------------------------------------------------
| Archive old history
|--------------------------------------------------------------------------
*/

async function archiveOldHistory(
    client,
    chat,
    entity,
    stats
) {
    const chatId =
        String(
            chat.telegramId
        );


    const targetDate =
        getHistoryStartDate();


    /*
     * Check oldest message currently
     * stored in MongoDB.
     */
    const state =
        await getChatMessageState(
            chatId
        );


    const oldestStoredDate =
        state.oldest?.date
            ? new Date(
                state.oldest.date
            )
            : null;


    /*
     * History is already complete.
     */
    if (
        oldestStoredDate &&
        oldestStoredDate <=
            targetDate
    ) {
        return;
    }


    /*
     * Start from newest Telegram message
     * and walk backward.
     */
    let offsetId = 0;


    while (true) {
        const messages =
            await getMessagesWithRetry(
                client,
                entity,
                {
                    limit:
                        BATCH_SIZE,

                    offsetId,
                }
            );


        if (
            !messages ||
            messages.length === 0
        ) {
            break;
        }


        let reachedTarget =
            false;


        /*
         * Keep only messages inside
         * the requested history window.
         */
        const validMessages =
            [];


        for (
            const message of messages
        ) {
            const date =
                getMessageDate(
                    message
                );


            if (!date) {
                continue;
            }


            if (
                date <
                targetDate
            ) {
                reachedTarget =
                    true;

                continue;
            }


            validMessages.push(
                message
            );
        }


        if (
            validMessages.length
        ) {
            await processMessages(
                validMessages,
                chatId,
                stats
            );
        }


        /*
         * We reached the requested
         * number of days.
         */
        if (
            reachedTarget
        ) {
            break;
        }


        /*
         * Find oldest message in
         * current Telegram batch.
         */
        const ids =
            messages
                .map(
                    (message) =>
                        Number(
                            message.id
                        )
                )
                .filter(
                    Number.isFinite
                );


        if (!ids.length) {
            break;
        }


        const oldestId =
            Math.min(...ids);


        /*
         * Move backward.
         *
         * offsetId is exclusive.
         */
        if (
            oldestId <=
            offsetId
        ) {
            break;
        }


        offsetId =
            oldestId;


        if (
            messages.length <
            BATCH_SIZE
        ) {
            break;
        }
    }
}


/*
|--------------------------------------------------------------------------
| Archive one chat
|--------------------------------------------------------------------------
*/

async function archiveChat(
    client,
    chat,
    entity
) {
    const stats = {
        inserted: 0,
        existing: 0,
        media: 0,
        webm: 0,
        stickers: 0,
        animations: 0,
        large: 0,
    };


    /*
     * --------------------------------------------
     * 1. New messages
     * --------------------------------------------
     */
    await archiveNewMessages(
        client,
        chat,
        entity,
        stats
    );


    /*
     * --------------------------------------------
     * 2. Missing old history
     * --------------------------------------------
     */
    await archiveOldHistory(
        client,
        chat,
        entity,
        stats
    );


    return stats;
}


/*
|--------------------------------------------------------------------------
| Main
|--------------------------------------------------------------------------
*/

async function main() {
    try {
        await connectToDatabase();

        const client =
            await getTelegramClient();


        /*
         * Get Telegram dialogs directly.
         *
         * This makes this file safe even if
         * archive-chats.js was not executed.
         */
        const dialogs =
            await client.getDialogs({});


        const telegramChats =
            dialogs.filter(
                (dialog) => {
                    const entity =
                        dialog.entity;


                    if (!entity) {
                        return false;
                    }


                    if (
                        entity.className !==
                        "User"
                    ) {
                        return false;
                    }


                    if (
                        entity.bot === true
                    ) {
                        return false;
                    }


                    return true;
                }
            );


        /*
         * Sync chats into MongoDB.
         *
         * Existing chats are preserved.
         * New chats are created.
         */
        let newChats = 0;


        const entityMap =
            new Map();


        for (
            const dialog of
            telegramChats
        ) {
            const user =
                dialog.entity;


            const telegramId =
                user.id.toString();


            entityMap.set(
                telegramId,
                user
            );


            const existing =
                await Chat.exists({
                    telegramId,
                });


            const me =
                await client.getMe();


            const isSavedMessages =
                telegramId ===
                me.id.toString();


            const name =
                `${user.firstName || ""} ${user.lastName || ""}`
                    .trim();


            const title =
                isSavedMessages
                    ? "Saved Messages"
                    : (
                        name ||
                        user.username ||
                        "Unknown"
                    );


            await Chat.updateOne(
                {
                    telegramId,
                },
                {
                    $set: {
                        type: "private",

                        title,

                        username:
                            user.username ||
                            null,

                        firstName:
                            user.firstName ||
                            null,

                        lastName:
                            user.lastName ||
                            null,
                    },

                    $setOnInsert: {
                        telegramId,

                        lastArchivedMessageId:
                            0,
                    },
                },
                {
                    upsert: true,
                }
            );


            if (!existing) {
                newChats++;
            }
        }


        /*
         * Load MongoDB chats AFTER syncing them.
         */
        const chats =
            await Chat.find({
                type: "private",
            }).lean();


        console.log(
            `Message archive | chats=${chats.length} newChats=${newChats} history=${INITIAL_ARCHIVE_DAYS}d`
        );


        let totalInserted = 0;
        let totalExisting = 0;
        let totalMedia = 0;
        let totalWebM = 0;
        let totalStickers = 0;
        let totalAnimations = 0;
        let totalLarge = 0;
        let failedChats = 0;


        /*
         * Process every Telegram private chat.
         */
        for (
            const chat of chats
        ) {
            const entity =
                entityMap.get(
                    String(
                        chat.telegramId
                    )
                );


            /*
             * Chat exists in MongoDB
             * but not in current dialogs.
             */
            if (!entity) {
                continue;
            }


            try {
                const stats =
                    await archiveChat(
                        client,
                        chat,
                        entity
                    );


                totalInserted +=
                    stats.inserted;

                totalExisting +=
                    stats.existing;

                totalMedia +=
                    stats.media;

                totalWebM +=
                    stats.webm;

                totalStickers +=
                    stats.stickers;

                totalAnimations +=
                    stats.animations;

                totalLarge +=
                    stats.large;
            } catch (error) {
                failedChats++;

                console.error(
                    `Archive failed ${chat.telegramId}: ${error.message}`
                );
            }
        }


        console.log(
            [
                "Message archive completed",
                `inserted=${totalInserted}`,
                `existing=${totalExisting}`,
                `media=${totalMedia}`,
                `webm=${totalWebM}`,
                `stickers=${totalStickers}`,
                `animations=${totalAnimations}`,
                `large=${totalLarge}`,
                `failedChats=${failedChats}`,
            ].join(" | ")
        );


        await client.disconnect();

        process.exit(
            failedChats > 0
                ? 1
                : 0
        );
    } catch (error) {
        console.error(
            `Fatal archive error: ${error.message}`
        );

        process.exit(1);
    }
}


main();
