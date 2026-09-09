require("dotenv").config();

const {
    getTelegramClient,
} = require("./telegram");

const {
    connectToDatabase,
} = require("./database/mongodb");

const Chat =
    require("./database/models/Chat");


async function main() {
    try {
        await connectToDatabase();

        const client =
            await getTelegramClient();

        const me =
            await client.getMe();

        const myId =
            me.id.toString();

        const dialogs =
            await client.getDialogs({});

        const privateChats =
            dialogs.filter((dialog) => {
                const entity =
                    dialog.entity;

                if (!entity) {
                    return false;
                }

                /*
                 * Only private users.
                 */
                if (
                    entity.className !==
                    "User"
                ) {
                    return false;
                }

                /*
                 * Ignore bots.
                 */
                if (
                    entity.bot === true
                ) {
                    return false;
                }

                return true;
            });

        let created = 0;
        let existing = 0;

        /*
         * Sync Telegram private chats
         * with MongoDB.
         *
         * telegramId is the unique key.
         */
        for (const dialog of privateChats) {
            const user =
                dialog.entity;

            const telegramId =
                user.id.toString();

            const isSavedMessages =
                telegramId === myId;

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

            const chatData = {
                telegramId,

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
            };

            /*
             * Check whether chat already exists.
             */
            const existingChat =
                await Chat.exists({
                    telegramId,
                });

            /*
             * IMPORTANT:
             *
             * Only update chat information.
             * Do NOT overwrite
             * lastArchivedMessageId.
             */
            await Chat.updateOne(
                {
                    telegramId,
                },
                {
                    $set: chatData,

                    $setOnInsert: {
                        lastArchivedMessageId: 0,
                    },
                },
                {
                    upsert: true,
                }
            );

            if (existingChat) {
                existing++;
            } else {
                created++;
            }
        }

        console.log(
            `Chats synced | telegram=${privateChats.length} created=${created} existing=${existing}`
        );

        await client.disconnect();

        process.exit(0);
    } catch (error) {
        console.error(
            `Archive chats failed: ${error.message}`
        );

        process.exit(1);
    }
}


main();
