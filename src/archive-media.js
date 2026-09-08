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
    Number(process.env.INITIAL_ARCHIVE_DAYS || 1);

const BATCH_SIZE =
    Number(process.env.MESSAGE_BATCH_SIZE || 100);

const MAX_MEDIA_SIZE =
    10 * 1024 * 1024;

const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}


/*
|--------------------------------------------------------------------------
| Telegram media detection
|--------------------------------------------------------------------------
*/

/*
 * Get the actual size of a Telegram photo.
 *
 * Telegram photos can contain multiple PhotoSize objects.
 * We use the largest available size because that is the
 * version that can be downloaded.
 */
function getTelegramPhotoSize(photo) {
    if (!photo || !Array.isArray(photo.sizes)) {
        return null;
    }

    let largestSize = 0;

    for (const size of photo.sizes) {
        /*
         * Normal PhotoSize
         */
        if (
            typeof size.size === "number" &&
            size.size > largestSize
        ) {
            largestSize = size.size;
        }

        /*
         * Progressive PhotoSize
         *
         * The sizes array contains the progressive
         * byte sizes. The last value is the largest.
         */
        if (
            Array.isArray(size.sizes) &&
            size.sizes.length > 0
        ) {
            const progressiveSize =
                Number(
                    size.sizes[
                        size.sizes.length - 1
                    ]
                );

            if (
                Number.isFinite(progressiveSize) &&
                progressiveSize > largestSize
            ) {
                largestSize =
                    progressiveSize;
            }
        }
    }

    return largestSize > 0
        ? largestSize
        : null;
}


/*
 * Get Telegram document attributes.
 */
function getDocumentAttributes(message) {
    if (
        !message.document ||
        !Array.isArray(message.document.attributes)
    ) {
        return [];
    }

    return message.document.attributes;
}


/*
 * Check whether a Telegram document is a sticker.
 */
function isTelegramSticker(message) {
    const attributes =
        getDocumentAttributes(message);

    return attributes.some(
        (attribute) =>
            attribute.className ===
            "DocumentAttributeSticker"
    );
}


/*
 * Check whether a Telegram document is an animated GIF.
 *
 * GIFs in Telegram are represented using
 * DocumentAttributeAnimated.
 */
function isTelegramAnimation(message) {
    const attributes =
        getDocumentAttributes(message);

    return attributes.some(
        (attribute) =>
            attribute.className ===
            "DocumentAttributeAnimated"
    );
}


/*
 * Get media information.
 *
 * Returns:
 *
 * {
 *     media: {...} | null,
 *     reason: null | "sticker" | "animation" | "too_large"
 * }
 */
function getMediaInfo(message) {

    /*
     * Photo
     */
    if (message.photo) {
        const size =
            getTelegramPhotoSize(
                message.photo
            );

        /*
         * If Telegram gives us the photo size
         * and it is larger than 10 MB, skip it.
         */
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

        /*
         * Sticker
         *
         * Check this BEFORE video/other document
         * classification because video stickers are
         * WebM documents with video attributes.
         */
        if (
            isTelegramSticker(message)
        ) {
            return {
                media: null,
                reason: "sticker",
            };
        }


        /*
         * Animated / GIF
         */
        if (
            isTelegramAnimation(message)
        ) {
            return {
                media: null,
                reason: "animation",
            };
        }


        const attributes =
            getDocumentAttributes(
                message
            );


        const size =
            Number(
                message.document.size
            ) || null;


        /*
         * Any document larger than 10 MB
         */
        if (
            size !== null &&
            size > MAX_MEDIA_SIZE
        ) {
            return {
                media: null,
                reason: "too_large",
            };
        }


        /*
         * Video
         */
        const isVideo =
            attributes.some(
                (attribute) =>
                    attribute.className ===
                    "DocumentAttributeVideo"
            );


        if (isVideo) {
            return {
                media: {
                    type: "video",

                    mimeType:
                        message.document.mimeType ||
                        "video/mp4",

                    size,
                },

                reason: null,
            };
        }


        /*
         * Voice message
         */
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
                        message.document.mimeType ||
                        "audio/ogg",

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
            console.error(
                `Telegram request failed ` +
                `(attempt ${attempt}/${MAX_RETRIES})`
            );

            console.error(
                error.message
            );


            if (
                attempt ===
                MAX_RETRIES
            ) {
                throw error;
            }


            console.log(
                `Waiting ${RETRY_DELAY / 1000}s before retry...`
            );


            await sleep(
                RETRY_DELAY
            );


            try {
                if (!client.connected) {
                    await client.connect();
                }
            } catch {
                // Ignore reconnect error.
            }
        }
    }
}


/*
|--------------------------------------------------------------------------
| Save messages
|--------------------------------------------------------------------------
*/

async function saveMessages(
    documents
) {
    if (
        documents.length === 0
    ) {
        return {
            inserted: 0,
            duplicates: 0,
        };
    }


    try {
        const result =
            await Message.insertMany(
                documents,
                {
                    ordered: false,
                }
            );


        return {
            inserted: result.length,
            duplicates: 0,
        };

    } catch (error) {
        /*
         * insertMany with ordered:false can insert
         * valid documents while reporting duplicate
         * errors for existing messages.
         */

        if (
            error.code === 11000 ||
            error.writeErrors
        ) {
            let duplicates = 0;


            if (
                Array.isArray(
                    error.writeErrors
                )
            ) {
                duplicates =
                    error.writeErrors.filter(
                        (writeError) =>
                            writeError.code ===
                            11000
                    ).length;
            }


            /*
             * Mongoose may expose insertedDocs
             * when partial insertion occurred.
             */
            const inserted =
                Array.isArray(
                    error.insertedDocs
                )
                    ? error.insertedDocs.length
                    : Math.max(
                        0,
                        documents.length -
                        duplicates
                    );


            const nonDuplicateErrors =
                Array.isArray(
                    error.writeErrors
                )
                    ? error.writeErrors.filter(
                        (writeError) =>
                            writeError.code !==
                            11000
                    )
                    : [];


            if (
                nonDuplicateErrors.length === 0
            ) {
                return {
                    inserted,
                    duplicates,
                };
            }
        }


        throw error;
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
    console.log(
        "\n========================================"
    );

    console.log(
        `Archiving: ${chat.title}`
    );

    console.log(
        `Chat ID: ${chat.telegramId}`
    );

    console.log(
        "========================================"
    );


    const lastArchivedMessageId =
        Number(
            chat.lastArchivedMessageId || 0
        );


    /*
     * First run:
     *
     * Archive only the last N days.
     */
    let startTimestamp = null;


    if (
        lastArchivedMessageId === 0
    ) {
        const startDate =
            new Date();


        startDate.setDate(
            startDate.getDate() -
            INITIAL_ARCHIVE_DAYS
        );


        startTimestamp =
            Math.floor(
                startDate.getTime() /
                1000
            );


        console.log(
            `Initial archive window: last ${INITIAL_ARCHIVE_DAYS} day(s)`
        );

    } else {
        /*
         * Future runs:
         *
         * Only messages newer than the
         * last archived message.
         */
        console.log(
            `Incremental archive from message ID ${lastArchivedMessageId}`
        );
    }


    let offsetId = 0;

    let totalFetched = 0;
    let totalSaved = 0;
    let totalDuplicates = 0;
    let totalMedia = 0;

    let totalSkippedStickers = 0;
    let totalSkippedAnimations = 0;
    let totalSkippedLargeMedia = 0;

    let highestMessageId =
        lastArchivedMessageId;


    while (true) {
        const options = {
            limit:
            BATCH_SIZE,
        };


        /*
         * Incremental mode:
         *
         * Only retrieve messages newer than
         * the last archived message.
         */
        if (
            lastArchivedMessageId > 0
        ) {
            options.minId =
                lastArchivedMessageId;
        }


        /*
         * Initial mode:
         *
         * Use offsetId to walk backward
         * through the history.
         */
        if (
            lastArchivedMessageId === 0 &&
            offsetId > 0
        ) {
            options.offsetId =
                offsetId;
        }


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


        totalFetched +=
            messages.length;


        const documents = [];


        for (
            const message of messages
        ) {
            if (
                !message.id ||
                !message.date
            ) {
                continue;
            }


            const telegramMessageId =
                Number(
                    message.id
                );


            /*
             * Keep track of the highest ID
             * we've seen.
             */
            if (
                telegramMessageId >
                highestMessageId
            ) {
                highestMessageId =
                    telegramMessageId;
            }


            /*
             * Initial archive only:
             *
             * Ignore messages older than
             * the configured date.
             */
            if (
                startTimestamp !== null &&
                message.date <
                startTimestamp
            ) {
                continue;
            }


            const mediaResult =
                getMediaInfo(
                    message
                );


            /*
             * Sticker
             */
            if (
                mediaResult.reason ===
                "sticker"
            ) {
                totalSkippedStickers++;

                continue;
            }


            /*
             * GIF / Animation
             */
            if (
                mediaResult.reason ===
                "animation"
            ) {
                totalSkippedAnimations++;

                continue;
            }


            /*
             * Media larger than 10 MB
             */
            if (
                mediaResult.reason ===
                "too_large"
            ) {
                totalSkippedLargeMedia++;

                continue;
            }


            const media =
                mediaResult.media;


            if (media) {
                totalMedia++;
            }


            documents.push({
                telegramId:
                    telegramMessageId,

                chatId:
                    chat.telegramId,

                senderId:
                    message.senderId
                        ?.toString() ||
                    chat.telegramId,

                text:
                    message.message ||
                    "",

                date:
                    new Date(
                        message.date *
                        1000
                    ),

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
            });
        }


        const result =
            await saveMessages(
                documents
            );


        totalSaved +=
            result.inserted;

        totalDuplicates +=
            result.duplicates;


        const batchMedia =
            documents.filter(
                (item) =>
                    item.media &&
                    item.media.type !== null
            ).length;


        console.log(
            `Fetched: ${messages.length} | ` +
            `Saved: ${result.inserted} | ` +
            `Duplicates: ${result.duplicates} | ` +
            `Media: ${batchMedia} | ` +
            `Skipped stickers: ${totalSkippedStickers} | ` +
            `Skipped animations: ${totalSkippedAnimations} | ` +
            `Skipped >10MB: ${totalSkippedLargeMedia}`
        );


        /*
         * Update cursor after every successful
         * batch.
         *
         * This makes the archive resumable.
         */
        if (
            highestMessageId >
            Number(
                chat.lastArchivedMessageId || 0
            )
        ) {
            await Chat.updateOne(
                {
                    _id:
                        chat._id,
                },
                {
                    $set: {
                        lastArchivedMessageId:
                            highestMessageId,
                    },
                }
            );


            chat.lastArchivedMessageId =
                highestMessageId;
        }


        /*
         * Incremental mode:
         *
         * getMessages with minId gives us
         * newer messages, so there is no need
         * to paginate backward.
         */
        if (
            lastArchivedMessageId > 0
        ) {
            break;
        }


        /*
         * Initial archive:
         *
         * Continue walking backward.
         */
        const oldestMessage =
            messages[
                messages.length - 1
            ];


        if (
            oldestMessage.date <
            startTimestamp
        ) {
            break;
        }


        offsetId =
            Number(
                oldestMessage.id
            );


        if (
            messages.length <
            BATCH_SIZE
        ) {
            break;
        }
    }


    console.log(
        "\nChat completed:"
    );

    console.log(
        `Fetched: ${totalFetched}`
    );

    console.log(
        `Saved: ${totalSaved}`
    );

    console.log(
        `Duplicates: ${totalDuplicates}`
    );

    console.log(
        `Media: ${totalMedia}`
    );

    console.log(
        `Skipped stickers: ${totalSkippedStickers}`
    );

    console.log(
        `Skipped animations: ${totalSkippedAnimations}`
    );

    console.log(
        `Skipped >10MB media: ${totalSkippedLargeMedia}`
    );

    console.log(
        `Last archived message ID: ${highestMessageId}`
    );
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
         * Load dialogs only once.
         */
        const dialogs =
            await client.getDialogs({});


        /*
         * ONLY real users.
         *
         * Groups:
         *   excluded
         *
         * Channels:
         *   excluded
         *
         * Bots:
         *   excluded
         */
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


        console.log(
            `Found ${telegramChats.length} private chats to archive.`
        );


        /*
         * Telegram ID -> entity
         */
        const entityMap =
            new Map();


        for (
            const dialog of telegramChats
        ) {
            const entity =
                dialog.entity;


            entityMap.set(
                entity.id.toString(),
                entity
            );
        }


        /*
         * Get private chats from MongoDB.
         */
        const chats =
            await Chat.find({
                type: "private",
            }).lean();


        /*
         * Keep only chats that still exist
         * as real Telegram users.
         */
        const chatsToArchive =
            chats.filter(
                (chat) =>
                    entityMap.has(
                        chat.telegramId
                    )
            );


        console.log(
            `MongoDB chats to archive: ${chatsToArchive.length}`
        );


        for (
            const chat of chatsToArchive
        ) {
            const entity =
                entityMap.get(
                    chat.telegramId
                );


            let success = false;


            for (
                let attempt = 1;
                attempt <= MAX_RETRIES;
                attempt++
            ) {
                try {
                    await archiveChat(
                        client,
                        chat,
                        entity
                    );


                    success = true;

                    break;

                } catch (error) {
                    console.error(
                        `\nFailed to archive "${chat.title}" ` +
                        `(attempt ${attempt}/${MAX_RETRIES})`
                    );


                    console.error(
                        error.message
                    );


                    if (
                        attempt <
                        MAX_RETRIES
                    ) {
                        console.log(
                            `Retrying in ${RETRY_DELAY / 1000}s...`
                        );


                        await sleep(
                            RETRY_DELAY
                        );
                    }
                }
            }


            if (!success) {
                console.error(
                    `\nSkipping chat: ${chat.title}`
                );
            }
        }


        console.log(
            "\n========================================"
        );

        console.log(
            "ARCHIVE COMPLETED"
        );

        console.log(
            "========================================"
        );

    } catch (error) {
        console.error(
            "\nFatal error:"
        );

        console.error(
            error
        );

        process.exitCode = 1;
    }
}


main();
