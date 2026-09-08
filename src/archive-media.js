require("dotenv").config();

const fs =
    require("fs");

const os =
    require("os");

const path =
    require("path");


const {
    getTelegramClient,
} = require("./telegram");


const {
    connectToDatabase,
} = require("./database/mongodb");


const Message =
    require("./database/models/Message");


const {
    uploadFileFromPath,
} = require("./storage/b2");


/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const MAX_RETRIES = 5;

const RETRY_DELAY = 3000;


/*
 * Maximum media size.
 *
 * Any media larger than this is skipped
 * WITHOUT downloading it.
 *
 * This applies to:
 *
 * - photos
 * - videos
 * - voices
 */
const MAX_MEDIA_SIZE =
    10 * 1024 * 1024;


/*
 * Number of media files processed
 * concurrently.
 *
 * Start with 3.
 */
const MEDIA_CONCURRENCY =
    Math.max(
        1,
        Number(
            process.env.MEDIA_CONCURRENCY || 3
        )
    );


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
 * Get Telegram document attributes safely.
 *
 * Stickers and GIF/animations are usually stored
 * by Telegram as documents.
 */
function getDocumentAttributes(
    telegramMessage
) {
    const document =
        telegramMessage?.media?.document ||
        telegramMessage?.document ||
        null;


    if (!document) {
        return [];
    }


    return Array.isArray(
        document.attributes
    )
        ? document.attributes
        : [];
}


/*
 * Check whether the Telegram message is a sticker.
 *
 * This is intentionally based on Telegram's
 * DocumentAttributeSticker rather than MIME type.
 *
 * This is important because video stickers can
 * have:
 *
 *     mimeType = video/webm
 *
 * while actually being stickers.
 */
function isTelegramSticker(
    telegramMessage
) {
    const attributes =
        getDocumentAttributes(
            telegramMessage
        );


    return attributes.some(
        (attribute) =>
            attribute &&
            attribute.className ===
                "DocumentAttributeSticker"
    );
}


/*
 * Check whether the Telegram message is an
 * animated media / GIF.
 *
 * Telegram defines DocumentAttributeAnimated
 * for animated GIF media.
 */
function isTelegramAnimation(
    telegramMessage
) {
    const attributes =
        getDocumentAttributes(
            telegramMessage
        );


    return attributes.some(
        (attribute) =>
            attribute &&
            attribute.className ===
                "DocumentAttributeAnimated"
    );
}


/*
 * Determine whether this Telegram message should
 * be excluded from media archiving.
 *
 * We skip:
 *
 * - stickers
 * - animated GIFs
 */
function shouldSkipTelegramMedia(
    telegramMessage
) {
    if (
        isTelegramSticker(
            telegramMessage
        )
    ) {
        return {
            skip: true,
            reason: "sticker",
        };
    }


    if (
        isTelegramAnimation(
            telegramMessage
        )
    ) {
        return {
            skip: true,
            reason: "animation",
        };
    }


    return {
        skip: false,
        reason: null,
    };
}


/*
|--------------------------------------------------------------------------
| File extension
|--------------------------------------------------------------------------
*/

function getExtension(
    mediaType,
    mimeType
) {
    /*
     * Prefer MIME type when possible.
     */
    if (mimeType) {
        const mime =
            mimeType.toLowerCase();


        if (
            mime ===
            "image/jpeg"
        ) {
            return "jpg";
        }


        if (
            mime ===
            "image/png"
        ) {
            return "png";
        }


        if (
            mime ===
            "video/mp4"
        ) {
            return "mp4";
        }


        if (
            mime ===
            "audio/ogg"
        ) {
            return "ogg";
        }


        const mimeExtension =
            mime.split("/")[1];


        if (
            mimeExtension &&
            !mimeExtension.includes(";")
        ) {
            return mimeExtension;
        }
    }


    switch (
        mediaType
    ) {
        case "photo":
            return "jpg";

        case "video":
            return "mp4";

        case "voice":
            return "ogg";

        default:
            return "bin";
    }
}


/*
|--------------------------------------------------------------------------
| Format bytes
|--------------------------------------------------------------------------
*/

function formatBytes(
    bytes
) {
    if (
        bytes < 1024
    ) {
        return `${bytes} B`;
    }


    if (
        bytes < 1024 * 1024
    ) {
        return `${(
            bytes / 1024
        ).toFixed(2)} KB`;
    }


    if (
        bytes < 1024 *
        1024 *
        1024
    ) {
        return `${(
            bytes /
            (1024 * 1024)
        ).toFixed(2)} MB`;
    }


    return `${(
        bytes /
        (1024 * 1024 * 1024)
    ).toFixed(2)} GB`;
}


/*
|--------------------------------------------------------------------------
| Telegram connection
|--------------------------------------------------------------------------
*/

async function reconnectTelegram(
    client
) {
    if (
        client.connected
    ) {
        return;
    }


    console.log(
        "Telegram disconnected. Reconnecting..."
    );


    await client.connect();


    console.log(
        "Telegram reconnected."
    );
}


/*
|--------------------------------------------------------------------------
| Download media with retry
|--------------------------------------------------------------------------
*/

async function downloadMediaWithRetry(
    client,
    telegramMessage,
    outputFile
) {
    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        try {
            /*
             * Remove previous partial file.
             */
            await fs.promises.rm(
                outputFile,
                {
                    force: true,
                }
            );


            await reconnectTelegram(
                client
            );


            console.log(
                `Downloading from Telegram ` +
                `(attempt ${attempt}/${MAX_RETRIES})...`
            );


            await client.downloadMedia(
                telegramMessage,
                {
                    outputFile,
                }
            );


            const stats =
                await fs.promises.stat(
                    outputFile
                );


            if (
                !stats ||
                stats.size === 0
            ) {
                throw new Error(
                    "Telegram downloaded an empty file"
                );
            }


            console.log(
                `Downloaded: ${formatBytes(stats.size)}`
            );


            return stats.size;

        } catch (error) {
            console.error(
                "Telegram media download failed:"
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
                `Retrying download in ${RETRY_DELAY / 1000}s...`
            );


            await sleep(
                RETRY_DELAY
            );


            try {
                if (
                    client.connected
                ) {
                    await client.disconnect();
                }
            } catch {
                // Ignore.
            }


            await sleep(
                500
            );


            try {
                await client.connect();
            } catch {
                // The next attempt will retry.
            }
        }
    }
}


/*
|--------------------------------------------------------------------------
| B2 upload with retry
|--------------------------------------------------------------------------
*/

async function uploadMediaWithRetry({
    key,
    filePath,
    contentType,
    size,
}) {
    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        try {
            const stats =
                await fs.promises.stat(
                    filePath
                );


            if (
                stats.size === 0
            ) {
                throw new Error(
                    "Cannot upload an empty file"
                );
            }


            /*
             * Final protection before B2 upload.
             *
             * No media larger than 10 MB should
             * ever reach B2.
             */
            if (
                stats.size >
                MAX_MEDIA_SIZE
            ) {
                throw new Error(
                    `File exceeds maximum media size: ` +
                    `${formatBytes(stats.size)} > ` +
                    `${formatBytes(MAX_MEDIA_SIZE)}`
                );
            }


            console.log(
                `Uploading to B2 ` +
                `(attempt ${attempt}/${MAX_RETRIES})...`
            );


            await uploadFileFromPath({
                key,

                filePath,

                contentType,

                size:
                    size ??
                    stats.size,
            });


            console.log(
                `B2 upload completed: ${key}`
            );


            return true;

        } catch (error) {
            console.error(
                "B2 upload failed:"
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
                `Retrying B2 upload in ${RETRY_DELAY / 1000}s...`
            );


            await sleep(
                RETRY_DELAY
            );
        }
    }


    return false;
}


/*
|--------------------------------------------------------------------------
| Telegram entity map
|--------------------------------------------------------------------------
*/

async function getTelegramEntityMap(
    client
) {
    await reconnectTelegram(
        client
    );


    /*
     * getDialogs is executed only once
     * for this stage.
     */
    const dialogs =
        await client.getDialogs({});


    const entityMap =
        new Map();


    for (
        const dialog of dialogs
    ) {
        const entity =
            dialog.entity;


        if (!entity) {
            continue;
        }


        /*
         * Only real Telegram users.
         *
         * This excludes:
         * - groups
         * - supergroups
         * - channels
         */
        if (
            entity.className !==
            "User"
        ) {
            continue;
        }


        /*
         * Exclude bots.
         */
        if (
            entity.bot === true
        ) {
            continue;
        }


        entityMap.set(
            entity.id.toString(),
            entity
        );
    }


    return entityMap;
}


/*
|--------------------------------------------------------------------------
| Mark media status
|--------------------------------------------------------------------------
*/

async function updateMediaStatus(
    messageId,
    update
) {
    try {
        await Message.updateOne(
            {
                _id:
                messageId,
            },
            {
                $set:
                update,
            }
        );
    } catch (error) {
        console.error(
            "Failed to update media status:"
        );

        console.error(
            error.message
        );
    }
}


/*
|--------------------------------------------------------------------------
| Process one media message
|--------------------------------------------------------------------------
*/

async function processMedia(
    client,
    message,
    entity
) {
    const mediaType =
        message.media.type;


    /*
     * Get actual Telegram message FIRST.
     *
     * We need the real Telegram message because
     * MongoDB only knows that this is a "video".
     *
     * A Telegram sticker can also appear as:
     *
     *     type: video
     *     mimeType: video/webm
     *
     * Therefore we MUST inspect Telegram's
     * DocumentAttributeSticker before downloading.
     */
    let telegramMessage;


    try {
        await reconnectTelegram(
            client
        );


        const telegramMessages =
            await client.getMessages(
                entity,
                {
                    ids:
                    message.telegramId,
                }
            );


        telegramMessage =
            telegramMessages[0];


        if (
            !telegramMessage
        ) {
            throw new Error(
                "Telegram message not found"
            );
        }

    } catch (error) {
        console.error(
            "Failed to get Telegram message:"
        );


        console.error(
            error.message
        );


        await updateMediaStatus(
            message._id,
            {
                "media.status":
                    "failed",
            }
        );


        return "failed";
    }


    /*
     * IMPORTANT:
     *
     * Detect stickers and GIFs BEFORE creating
     * a storage key and BEFORE downloading.
     */
    const skipResult =
        shouldSkipTelegramMedia(
            telegramMessage
        );


    if (
        skipResult.skip
    ) {
        console.log(
            `Skipping Telegram ${skipResult.reason}: ` +
            `${message.chatId}/${message.telegramId}`
        );


        await updateMediaStatus(
            message._id,
            {
                "media.status":
                    "skipped",
            }
        );


        return "skipped";
    }


    /*
     * IMPORTANT:
     *
     * Maximum size now applies to ALL media:
     *
     * - photo
     * - video
     * - voice
     *
     * If MongoDB already knows the Telegram
     * file size, skip BEFORE downloading.
     */
    const storedMediaSize =
        Number(
            message.media.size || 0
        );


    if (
        storedMediaSize >
        MAX_MEDIA_SIZE
    ) {
        console.log(
            `Skipping large ${mediaType} before download: ` +
            `${formatBytes(storedMediaSize)}`
        );


        await updateMediaStatus(
            message._id,
            {
                "media.status":
                    "skipped",
            }
        );


        return "skipped";
    }


    const extension =
        getExtension(
            mediaType,
            message.media.mimeType
        );


    const storageKey =
        `media/${message.chatId}/${message.telegramId}.${extension}`;


    const tempDir =
        await fs.promises.mkdtemp(
            path.join(
                os.tmpdir(),
                "telegram-media-"
            )
        );


    const tempPath =
        path.join(
            tempDir,
            `${message.chatId}-${message.telegramId}.${extension}`
        );


    try {
        /*
         * Claim this media item.
         */
        const claimResult =
            await Message.updateOne(
                {
                    _id:
                    message._id,

                    /*
                     * Prevent accidentally processing
                     * an item that another process already
                     * uploaded.
                     */
                    "media.status": {
                        $in: [
                            "pending",
                            "failed",
                            null,
                        ],
                    },
                },
                {
                    $set: {
                        "media.status":
                            "uploading",
                    },
                }
            );


        /*
         * If another worker/process already claimed
         * this media, don't continue.
         */
        if (
            claimResult.modifiedCount === 0
        ) {
            console.log(
                "Media was already claimed by another worker. Skipping."
            );


            return "skipped";
        }


        /*
         * Download.
         */
        const downloadedSize =
            await downloadMediaWithRetry(
                client,
                telegramMessage,
                tempPath
            );


        const fileStats =
            await fs.promises.stat(
                tempPath
            );


        if (
            fileStats.size === 0
        ) {
            throw new Error(
                "Downloaded file is empty"
            );
        }


        /*
         * IMPORTANT:
         *
         * Final safety check for ALL media.
         *
         * This protects us if Telegram's stored
         * media.size was missing or incorrect.
         */
        if (
            fileStats.size >
            MAX_MEDIA_SIZE
        ) {
            console.log(
                `Media is too large: ` +
                `${formatBytes(fileStats.size)}`
            );


            await updateMediaStatus(
                message._id,
                {
                    "media.size":
                        fileStats.size,

                    "media.status":
                        "skipped",
                }
            );


            return "skipped";
        }


        console.log(
            `Ready for upload: ${formatBytes(downloadedSize)}`
        );


        /*
         * Upload to B2.
         */
        await uploadMediaWithRetry({
            key:
                storageKey,

            filePath:
                tempPath,

            contentType:
                message.media.mimeType ||
                "application/octet-stream",

            size:
                fileStats.size,
        });


        /*
         * Only mark as uploaded after
         * B2 confirms success.
         */
        const updateResult =
            await Message.updateOne(
                {
                    _id:
                    message._id,
                },
                {
                    $set: {
                        "media.storageKey":
                            storageKey,

                        "media.size":
                            fileStats.size,

                        "media.status":
                            "uploaded",
                    },
                }
            );


        if (
            updateResult.modifiedCount === 0
        ) {
            console.warn(
                `MongoDB media status was not updated for ` +
                `${message.chatId}/${message.telegramId}`
            );
        }


        console.log(
            `Uploaded successfully: ${storageKey}`
        );


        return "uploaded";

    } catch (error) {
        console.error(
            "\nMedia processing failed:"
        );


        console.error(
            error.message
        );


        await updateMediaStatus(
            message._id,
            {
                "media.status":
                    "failed",
            }
        );


        return "failed";

    } finally {
        /*
         * Always remove temporary files.
         */
        try {
            await fs.promises.rm(
                tempDir,
                {
                    recursive:
                        true,

                    force:
                        true,
                }
            );
        } catch (error) {
            console.error(
                "Failed to remove temporary directory:"
            );

            console.error(
                error.message
            );
        }
    }
}


/*
|--------------------------------------------------------------------------
| Concurrent media workers
|--------------------------------------------------------------------------
*/

async function processMediaConcurrently(
    client,
    messages,
    entityMap
) {
    let nextIndex = 0;


    let successful = 0;
    let failed = 0;
    let skipped = 0;


    /*
     * Worker function.
     */
    async function worker(
        workerId
    ) {
        while (true) {
            const currentIndex =
                nextIndex++;


            if (
                currentIndex >=
                messages.length
            ) {
                return;
            }


            const message =
                messages[
                    currentIndex
                ];


            console.log(
                "\n----------------------------------------"
            );


            console.log(
                `Worker ${workerId}`
            );


            console.log(
                `Chat: ${message.chatId}`
            );


            console.log(
                `Message: ${message.telegramId}`
            );


            console.log(
                `Type: ${message.media.type}`
            );


            console.log(
                `MIME: ${message.media.mimeType || "unknown"}`
            );


            console.log(
                `Size: ${formatBytes(Number(message.media.size || 0))}`
            );


            const entity =
                entityMap.get(
                    message.chatId
                );


            if (!entity) {
                console.log(
                    "Telegram entity not found. Skipping."
                );


                skipped++;

                continue;
            }


            const result =
                await processMedia(
                    client,
                    message,
                    entity
                );


            if (
                result ===
                "uploaded"
            ) {
                successful++;
            }


            if (
                result ===
                "failed"
            ) {
                failed++;
            }


            if (
                result ===
                "skipped"
            ) {
                skipped++;
            }
        }
    }


    /*
     * Don't create more workers than
     * there are actual messages.
     */
    const workerCount =
        Math.min(
            MEDIA_CONCURRENCY,
            messages.length
        );


    console.log(
        `Starting ${workerCount} media worker(s)...`
    );


    const workers = [];


    for (
        let i = 1;
        i <= workerCount;
        i++
    ) {
        workers.push(
            worker(i)
        );
    }


    await Promise.all(
        workers
    );


    return {
        successful,
        failed,
        skipped,
    };
}


/*
|--------------------------------------------------------------------------
| Main
|--------------------------------------------------------------------------
*/

async function main() {
    try {
        console.log(
            "Connecting to MongoDB..."
        );


        await connectToDatabase();


        console.log(
            "Connecting to Telegram..."
        );


        const client =
            await getTelegramClient();


        console.log(
            "Loading Telegram dialogs..."
        );


        const entityMap =
            await getTelegramEntityMap(
                client
            );


        console.log(
            `Telegram private users: ${entityMap.size}`
        );


        /*
         * Find only media that still needs
         * processing.
         */
        const messages =
            await Message.find({
                "media.type": {
                    $in: [
                        "photo",
                        "video",
                        "voice",
                    ],
                },

                "media.status": {
                    $in: [
                        "pending",
                        "failed",
                    ],
                },
            })
                .sort({
                    date: 1,
                })
                .lean();


        console.log(
            `Media files waiting for upload: ${messages.length}`
        );


        if (
            messages.length === 0
        ) {
            console.log(
                "No media files need processing."
            );


            await client.disconnect();


            process.exit(0);
        }


        /*
         * Process media concurrently.
         */
        const result =
            await processMediaConcurrently(
                client,
                messages,
                entityMap
            );


        console.log(
            "\n========================================"
        );


        console.log(
            "MEDIA ARCHIVE COMPLETED"
        );


        console.log(
            "========================================"
        );


        console.log(
            `Successful: ${result.successful}`
        );


        console.log(
            `Failed: ${result.failed}`
        );


        console.log(
            `Skipped: ${result.skipped}`
        );


        console.log(
            "========================================\n"
        );


        try {
            await client.disconnect();
        } catch {
            // Ignore.
        }


        process.exit(0);

    } catch (error) {
        console.error(
            "\nMedia archive failed:"
        );


        console.error(
            error
        );


        process.exit(1);
    }
}


/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

main();
