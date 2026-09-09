require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");

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

const MAX_MEDIA_SIZE =
    10 * 1024 * 1024;

const MAX_RETRIES =
    Number(process.env.MEDIA_MAX_RETRIES || 5);

const RETRY_DELAY =
    Number(process.env.MEDIA_RETRY_DELAY || 3000);

const MEDIA_CONCURRENCY =
    Math.max(
        1,
        Number(process.env.MEDIA_CONCURRENCY || 3)
    );

/*
 * One progress log per N completed media items.
 * Set to a large value to make logging almost silent.
 */
const LOG_PROGRESS_EVERY =
    Math.max(
        1,
        Number(process.env.MEDIA_LOG_EVERY || 1000)
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


function getFileExtensionFromMimeType(mimeType) {
    const mime = String(mimeType || "").toLowerCase();

    if (mime === "image/jpeg") return ".jpg";
    if (mime === "image/png") return ".png";
    if (mime === "image/webp") return ".webp";
    if (mime === "image/gif") return ".gif";
    if (mime === "video/mp4") return ".mp4";
    if (mime === "video/webm") return ".webm";
    if (mime === "audio/ogg") return ".ogg";
    if (mime === "audio/mpeg") return ".mp3";
    if (mime === "audio/mp4") return ".m4a";

    return "";
}


function getDocumentFileName(message) {
    const attributes =
        message?.document?.attributes;

    if (!Array.isArray(attributes)) {
        return "";
    }

    const attribute =
        attributes.find(
            (item) =>
                item?.className ===
                "DocumentAttributeFilename"
        );

    return attribute?.fileName || "";
}


function isWebmMessage(message, media) {
    const mimeType =
        String(
            media?.mimeType ||
            message?.document?.mimeType ||
            ""
        ).toLowerCase();

    if (mimeType === "video/webm" ||
        mimeType === "image/webm") {
        return true;
    }

    const fileName =
        getDocumentFileName(message).toLowerCase();

    return fileName.endsWith(".webm");
}


function getMediaMimeType(message, media) {
    if (media?.mimeType) {
        return media.mimeType;
    }

    if (message?.document?.mimeType) {
        return message.document.mimeType;
    }

    if (media?.type === "photo") {
        return "image/jpeg";
    }

    if (media?.type === "voice") {
        return "audio/ogg";
    }

    return "video/mp4";
}


function getMediaExtension(message, media) {
    const fileName =
        getDocumentFileName(message);

    const originalExtension =
        path.extname(fileName || "");

    if (originalExtension) {
        return originalExtension.toLowerCase();
    }

    return getFileExtensionFromMimeType(
        getMediaMimeType(message, media)
    ) || ".bin";
}


async function getMessagesWithRetry(
    client,
    entity,
    messageId
) {
    let lastError;

    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        try {
            const messages =
                await client.getMessages(
                    entity,
                    {
                        ids: Number(messageId),
                    }
                );

            if (!messages || messages.length === 0) {
                throw new Error(
                    `Telegram message not found: ${messageId}`
                );
            }

            return messages[0];

        } catch (error) {
            lastError = error;

            if (attempt === MAX_RETRIES) {
                break;
            }

            await sleep(RETRY_DELAY);

            try {
                if (!client.connected) {
                    await client.connect();
                }
            } catch {
                // Telegram client will retry on the next attempt.
            }
        }
    }

    throw lastError;
}


async function downloadMediaWithRetry(
    message,
    filePath
) {
    let lastError;

    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        try {
            await message.downloadMedia({
                outputFile: filePath,
            });

            if (!fs.existsSync(filePath)) {
                throw new Error(
                    "Telegram returned no downloaded file."
                );
            }

            return;

        } catch (error) {
            lastError = error;

            if (attempt === MAX_RETRIES) {
                break;
            }

            await sleep(RETRY_DELAY);
        }
    }

    throw lastError;
}


async function uploadMediaWithRetry({
    key,
    filePath,
    contentType,
    size,
}) {
    let lastError;

    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        try {
            const stats =
                fs.statSync(filePath);

            /*
             * Final safety check.
             * Nothing larger than 10 MB reaches B2.
             */
            if (stats.size > MAX_MEDIA_SIZE) {
                throw new Error(
                    "Media exceeds the 10 MB upload limit."
                );
            }

            /*
             * Final WebM safety check.
             */
            if (
                path.extname(filePath).toLowerCase() ===
                ".webm"
            ) {
                throw new Error(
                    "WebM media is not allowed."
                );
            }

            return await uploadFileFromPath({
                key,
                filePath,
                contentType,
                size,
            });

        } catch (error) {
            lastError = error;

            if (attempt === MAX_RETRIES) {
                break;
            }

            await sleep(RETRY_DELAY);
        }
    }

    throw lastError;
}


async function updateMediaStatus(
    messageId,
    update
) {
    await Message.updateOne(
        {
            _id: messageId,
        },
        {
            $set: update,
        }
    );
}


function buildStorageKey(
    message,
    media,
    extension
) {
    return (
        `media/${message.chatId}/` +
        `${message.telegramId}${extension}`
    );
}


/*
|--------------------------------------------------------------------------
| Process one media
|--------------------------------------------------------------------------
*/

async function processMedia(
    client,
    entityCache,
    dbMessage
) {
    const media =
        dbMessage.media;

    if (!media) {
        return {
            status: "ignored",
        };
    }

    if (
        media.status === "uploaded" ||
        media.status === "skipped"
    ) {
        return {
            status: "ignored",
        };
    }

    let tempDir = null;

    try {
        /*
         * If MongoDB already knows the media is WebM,
         * skip it without downloading.
         */
        if (
            String(media.mimeType || "")
                .toLowerCase() === "video/webm" ||
            String(media.mimeType || "")
                .toLowerCase() === "image/webm"
        ) {
            await updateMediaStatus(
                dbMessage._id,
                {
                    "media.status": "skipped",
                    "media.storageKey": null,
                }
            );

            return {
                status: "skipped",
            };
        }

        /*
         * If MongoDB already knows the media is too large,
         * skip it without downloading.
         */
        if (
            Number.isFinite(media.size) &&
            media.size > MAX_MEDIA_SIZE
        ) {
            await updateMediaStatus(
                dbMessage._id,
                {
                    "media.status": "skipped",
                    "media.storageKey": null,
                }
            );

            return {
                status: "skipped",
            };
        }

        const chatId =
            String(dbMessage.chatId);

        let entity =
            entityCache.get(chatId);

        if (!entity) {
            entity =
                await client.getEntity(chatId);

            entityCache.set(
                chatId,
                entity
            );
        }

        const telegramMessage =
            await getMessagesWithRetry(
                client,
                entity,
                dbMessage.telegramId
            );

        /*
         * Detect WebM from the real Telegram message.
         * This protects us even if MongoDB has incorrect
         * or incomplete MIME information.
         */
        if (
            isWebmMessage(
                telegramMessage,
                media
            )
        ) {
            await updateMediaStatus(
                dbMessage._id,
                {
                    "media.status": "skipped",
                    "media.storageKey": null,
                }
            );

            return {
                status: "skipped",
            };
        }

        const extension =
            getMediaExtension(
                telegramMessage,
                media
            );

        /*
         * Extra filename-based safety check.
         */
        if (
            extension.toLowerCase() === ".webm"
        ) {
            await updateMediaStatus(
                dbMessage._id,
                {
                    "media.status": "skipped",
                    "media.storageKey": null,
                }
            );

            return {
                status: "skipped",
            };
        }

        tempDir =
            await fs.promises.mkdtemp(
                path.join(
                    os.tmpdir(),
                    "telegram-media-"
                )
            );

        const filePath =
            path.join(
                tempDir,
                `${dbMessage.telegramId}${extension}`
            );

        await updateMediaStatus(
            dbMessage._id,
            {
                "media.status": "uploading",
            }
        );

        await downloadMediaWithRetry(
            telegramMessage,
            filePath
        );

        const stats =
            await fs.promises.stat(
                filePath
            );

        /*
         * Final size check after downloading.
         */
        if (
            stats.size > MAX_MEDIA_SIZE
        ) {
            await updateMediaStatus(
                dbMessage._id,
                {
                    "media.status": "skipped",
                    "media.size": stats.size,
                    "media.storageKey": null,
                }
            );

            return {
                status: "skipped",
            };
        }

        /*
         * Never allow WebM to reach the B2 uploader.
         */
        if (
            path.extname(filePath)
                .toLowerCase() === ".webm"
        ) {
            await updateMediaStatus(
                dbMessage._id,
                {
                    "media.status": "skipped",
                    "media.size": stats.size,
                    "media.storageKey": null,
                }
            );

            return {
                status: "skipped",
            };
        }

        const contentType =
            getMediaMimeType(
                telegramMessage,
                media
            );

        const key =
            buildStorageKey(
                dbMessage,
                media,
                extension
            );

        await uploadMediaWithRetry({
            key,
            filePath,
            contentType,
            size: stats.size,
        });

        await updateMediaStatus(
            dbMessage._id,
            {
                "media.storageKey": key,
                "media.size": stats.size,
                "media.status": "uploaded",
                "media.mimeType": contentType,
            }
        );

        return {
            status: "uploaded",
        };

    } catch (error) {
        try {
            await updateMediaStatus(
                dbMessage._id,
                {
                    "media.status": "failed",
                }
            );
        } catch {
            // Do not create extra logs for a secondary DB error.
        }

        return {
            status: "failed",
            error: error?.message || "Unknown error",
        };

    } finally {
        if (tempDir) {
            try {
                await fs.promises.rm(
                    tempDir,
                    {
                        recursive: true,
                        force: true,
                    }
                );
            } catch {
                // Ignore cleanup errors.
            }
        }
    }
}


/*
|--------------------------------------------------------------------------
| Concurrent processing
|--------------------------------------------------------------------------
*/

async function processMediaConcurrently(
    client,
    messages
) {
    const entityCache =
        new Map();

    let nextIndex = 0;
    let completed = 0;
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    const failureSamples = [];

    async function worker() {
        while (true) {
            const index =
                nextIndex++;

            if (index >= messages.length) {
                return;
            }

            const result =
                await processMedia(
                    client,
                    entityCache,
                    messages[index]
                );

            completed++;

            if (result.status === "uploaded") {
                uploaded++;
            } else if (result.status === "skipped") {
                skipped++;
            } else if (result.status === "failed") {
                failed++;

                if (
                    failureSamples.length < 5
                ) {
                    failureSamples.push(
                        `${messages[index].chatId}/${messages[index].telegramId}: ${result.error}`
                    );
                }
            }

            if (
                completed % LOG_PROGRESS_EVERY === 0
            ) {
                console.log(
                    `Media progress ${completed}/${messages.length} | ` +
                    `uploaded=${uploaded} skipped=${skipped} failed=${failed}`
                );
            }
        }
    }

    const workers =
        Array.from(
            {
                length: Math.min(
                    MEDIA_CONCURRENCY,
                    messages.length
                ),
            },
            () => worker()
        );

    await Promise.all(workers);

    return {
        total: messages.length,
        uploaded,
        skipped,
        failed,
        failureSamples,
    };
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

        if (messages.length === 0) {
            console.log(
                "Media archive: nothing to upload."
            );

            return;
        }

        console.log(
            `Media archive started: ${messages.length} items | concurrency=${MEDIA_CONCURRENCY}`
        );

        const result =
            await processMediaConcurrently(
                client,
                messages
            );

        console.log(
            `Media archive completed | total=${result.total} uploaded=${result.uploaded} skipped=${result.skipped} failed=${result.failed}`
        );

        /*
         * Print only a maximum of 5 failure samples,
         * instead of one log per failed file.
         */
        if (
            result.failureSamples.length > 0
        ) {
            console.error(
                `Media failure samples: ${result.failureSamples.join(" | ")}`
            );
        }

    } catch (error) {
        console.error(
            `Media archive fatal error: ${error?.message || error}`
        );

        process.exitCode = 1;
    }
}


main();
