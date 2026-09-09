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
            process.env.INITIAL_ARCHIVE_DAYS || 365
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
| Normalize Telegram message date
|--------------------------------------------------------------------------
|
| Depending on the GramJS version / object representation,
| message.date can be a Date object or a Unix timestamp.
|
| This helper always returns Unix seconds.
|
*/

function getMessageTimestamp(date) {
    if (!date) {
        return null;
    }

    if (date instanceof Date) {
        return Math.floor(
            date.getTime() / 1000
        );
    }

    if (typeof date === "number") {
        /*
         * Seconds:
         * 1,700,000,000
         *
         * Milliseconds:
         * 1,700,000,000,000
         */
        if (date > 100000000000) {
            return Math.floor(
                date / 1000
            );
        }

        return Math.floor(date);
    }

    const parsedDate =
        new Date(date);

    if (
        !Number.isNaN(
            parsedDate.getTime()
        )
    ) {
        return Math.floor(
            parsedDate.getTime() / 1000
        );
    }

    return null;
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
            inserted:
                result.length,

            duplicates:
                0,
        };

    } catch (error) {

        /*
         * ordered:false allows MongoDB to insert
         * valid documents even when some documents
         * are duplicates.
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
| Build MongoDB message document
|--------------------------------------------------------------------------
*/

function buildMessageDocument(
    message,
    chat
) {
    const telegramMessageId =
        Number(
            message.id
        );


    const timestamp =
        getMessageTimestamp(
            message.date
        );


    if (
        !telegramMessageId ||
        !timestamp
    ) {
        return null;
    }


    const media =
        getMediaInfo(
            message
        );


    return {
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
                timestamp * 1000
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
    };
}


/*
|--------------------------------------------------------------------------
| Archive NEW messages
|--------------------------------------------------------------------------
|
| This part runs on every execution.
|
| It starts from lastArchivedMessageId and continues
| until there are no newer messages left.
|
*/

async function archiveNewMessages(
    client,
    chat,
    entity,
    lastArchivedMessageId
) {
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

            minId:
                lastArchivedMessageId,
        };


        /*
         * After the first request, use the oldest
         * message from the previous batch as offsetId
         * so we can continue through all newer messages.
         */
        if (
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
            const document =
                buildMessageDocument(
                    message,
                    chat
                );


            if (!document) {
                continue;
            }


            if (
                document.telegramId >
                highestMessageId
            ) {
                highestMessageId =
                    document.telegramId;
            }


            if (
                document.media &&
                document.media.type !== null
            ) {
                totalMedia++;
            }


            documents.push(
                document
            );
        }


        const result =
            await saveMessages(
                documents
            );


        totalSaved +=
            result.inserted;

        totalDuplicates +=
            result.duplicates;


        /*
         * Messages are returned newest -> oldest.
         *
         * The last message is therefore the oldest
         * message in this batch.
         */
        const oldestMessage =
            messages[
                messages.length - 1
            ];


        offsetId =
            Number(
                oldestMessage.id
            );


        /*
         * If Telegram returned less than the requested
         * batch size, there are no more messages.
         */
        if (
            messages.length <
            BATCH_SIZE
        ) {
            break;
        }
    }


    /*
     * Update the cursor only after the complete
     * incremental pass has succeeded.
     */
    if (
        highestMessageId >
        lastArchivedMessageId
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


    return {
        fetched:
            totalFetched,

        saved:
            totalSaved,

        duplicates:
            totalDuplicates,

        media:
            totalMedia,

        highestMessageId,
    };
}


/*
|--------------------------------------------------------------------------
| Backfill OLD messages
|--------------------------------------------------------------------------
|
| This part also runs on every execution.
|
| It ignores lastArchivedMessageId.
|
| It walks backward through Telegram history until
| INITIAL_ARCHIVE_DAYS is reached.
|
*/

async function archiveHistory(
    client,
    chat,
    entity
) {
    const startDate =
        new Date();

    startDate.setDate(
        startDate.getDate() -
        INITIAL_ARCHIVE_DAYS
    );


    const startTimestamp =
        Math.floor(
            startDate.getTime() / 1000
        );


    let offsetId = 0;

    let totalFetched = 0;
    let totalSaved = 0;
    let totalDuplicates = 0;
    let totalMedia = 0;


    while (true) {

        const options = {
            limit:
                BATCH_SIZE,
        };


        /*
         * offsetId means:
         * give me messages older than this ID.
         */
        if (
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


        let reachedTargetDate =
            false;


        for (
            const message of messages
        ) {
            const timestamp =
                getMessageTimestamp(
                    message.date
                );


            if (!timestamp) {
                continue;
            }


            /*
             * Messages older than the requested
             * archive window are not saved.
             */
            if (
                timestamp <
                startTimestamp
            ) {
                reachedTargetDate =
                    true;

                continue;
            }


            const document =
                buildMessageDocument(
                    message,
                    chat
                );


            if (!document) {
                continue;
            }


            if (
                document.media &&
                document.media.type !== null
            ) {
                totalMedia++;
            }


            documents.push(
                document
            );
        }


        const result =
            await saveMessages(
                documents
            );


        totalSaved +=
            result.inserted;

        totalDuplicates +=
            result.duplicates;


        /*
         * If we have already reached the target
         * date, there is no reason to request
         * older messages.
         */
        if (
            reachedTargetDate
        ) {
            break;
        }


        /*
         * The last message in the batch is the
         * oldest message returned.
         */
        const oldestMessage =
            messages[
                messages.length - 1
            ];


        const oldestTimestamp =
            getMessageTimestamp(
                oldestMessage.date
            );


        if (
            oldestTimestamp &&
            oldestTimestamp <=
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


    return {
        fetched:
            totalFetched,

        saved:
            totalSaved,

        duplicates:
            totalDuplicates,

        media:
            totalMedia,
    };
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
    const lastArchivedMessageId =
        Number(
            chat.lastArchivedMessageId || 0
        );


    /*
     * ---------------------------------------------------------------
     * 1. NEW MESSAGES
     * ---------------------------------------------------------------
     */

    const newMessages =
        await archiveNewMessages(
            client,
            chat,
            entity,
            lastArchivedMessageId
        );


    /*
     * ---------------------------------------------------------------
     * 2. HISTORY / BACKFILL
     * ---------------------------------------------------------------
     */

    const history =
        await archiveHistory(
            client,
            chat,
            entity
        );


    /*
     * ---------------------------------------------------------------
     * Summary
     * ---------------------------------------------------------------
     */

    console.log(
        `${chat.title} | ` +
        `new=${newMessages.saved}/${newMessages.fetched} ` +
        `history=${history.saved}/${history.fetched} ` +
        `duplicates=${newMessages.duplicates + history.duplicates} ` +
        `media=${newMessages.media + history.media} ` +
        `lastId=${chat.lastArchivedMessageId}`
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
            `Found ${telegramChats.length} private chats.`
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
            `MongoDB chats to archive: ${chatsToArchive.length} | ` +
            `history=${INITIAL_ARCHIVE_DAYS}d`
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
                        attempt ===
                        MAX_RETRIES
                    ) {
                        console.error(
                            `Archive failed ${chat.telegramId}: ${error.message}`
                        );
                    } else {
                        await sleep(
                            RETRY_DELAY
                        );
                    }
                }
            }


            if (!success) {
                console.error(
                    `Skipping chat: ${chat.title}`
                );
            }
        }


        console.log(
            "Messages archive completed."
        );


        try {
            await client.disconnect();
        } catch {
            // Ignore disconnect error.
        }


        process.exit(0);

    } catch (error) {

        console.error(
            `Archive messages failed: ${error.message}`
        );

        process.exit(1);
    }
}


main();
