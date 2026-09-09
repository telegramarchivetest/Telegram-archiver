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

function getMediaInfo(message) {
    /*
     * Photo
     */
    if (message.photo) {
        return {
            type: "photo",

            mimeType:
                "image/jpeg",

            size: null,
        };
    }


    /*
     * Document
     */
    if (message.document) {
        const attributes =
            message.document.attributes || [];


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
                type: "video",

                mimeType:
                    message.document.mimeType ||
                    "video/mp4",

                size:
                    Number(
                        message.document.size
                    ) || null,
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
                type: "voice",

                mimeType:
                    message.document.mimeType ||
                    "audio/ogg",

                size:
                    Number(
                        message.document.size
                    ) || null,
            };
        }
    }


    return null;
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
            if (
                attempt ===
                MAX_RETRIES
            ) {
                throw error;
            }


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


            const media =
                getMediaInfo(
                    message
                );


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
            `Media: ${batchMedia}`
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
                    if (
                        attempt === MAX_RETRIES
                    ) {
                        console.error(
                            `Archive chat failed ${chat.telegramId}: ${error.message}`
                        );
                    } else {
                        await sleep(RETRY_DELAY);
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
            "========================================\n"
        );


        try {
            await client.disconnect();
        } catch {
            // Ignore disconnect error.
        }


        process.exit(0);

    } catch (error) {
        console.error(
            "\nArchive messages failed:"
        );

        console.error(
            error
        );

        process.exit(1);
    }
}


main();