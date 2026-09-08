require("dotenv").config();

const { getTelegramClient } = require("./telegram");

const {
    connectToDatabase,
} = require("./database/mongodb");

const Chat = require("./database/models/Chat");


async function main() {
    await connectToDatabase();

    const client =
        await getTelegramClient();

    const me =
        await client.getMe();

    const myId =
        me.id.toString();

    console.log(
        `My Telegram ID: ${myId}\n`
    );

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
             * Remove bots.
             *
             * Saved Messages is not a bot,
             * so it remains.
             */
            if (entity.bot === true) {
                return false;
            }

            return true;
        });

    console.log(
        `Found ${privateChats.length} private chats.`
    );

    console.log(
        `(Users + Saved Messages, bots excluded)\n`
    );


    for (const dialog of privateChats) {
        const user =
            dialog.entity;

        const isSavedMessages =
            user.id?.toString() === myId;


        const name =
            `${user.firstName || ""} ${user.lastName || ""}`
                .trim();


        let title;


        if (isSavedMessages) {
            title =
                "Saved Messages";
        } else {
            title =
                name ||
                user.username ||
                "Unknown";
        }


        const chatData = {
            telegramId:
                user.id.toString(),

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


        await Chat.findOneAndUpdate(
            {
                telegramId:
                chatData.telegramId,
            },

            chatData,

            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
            }
        );


        console.log(
            `Saved: ${title} | ${chatData.telegramId}`
        );
    }


    console.log(
        "\nAll private chats saved."
    );


    await client.disconnect();

    process.exit(0);
}


main().catch((error) => {
    console.error(
        "\nArchive chats failed:"
    );

    console.error(error);

    process.exit(1);
});