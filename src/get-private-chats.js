const { getTelegramClient } = require("./telegram");

async function main() {
    const client = await getTelegramClient();

    console.log("Getting Telegram chats...\n");

    const dialogs = await client.getDialogs({});

    const privateChats = dialogs
        .filter((dialog) => {
            return dialog.entity?.className === "User";
        })
        .map((dialog) => {
            const user = dialog.entity;

            const name =
                `${user.firstName || ""} ${user.lastName || ""}`.trim();

            return {
                id: user.id.toString(),

                name:
                    name ||
                    user.username ||
                    "Unknown",

                username: user.username || null,

                firstName: user.firstName || null,

                lastName: user.lastName || null,
            };
        });

    console.log(
        `Found ${privateChats.length} private chats:\n`
    );

    privateChats.forEach((chat, index) => {
        console.log(
            `${index + 1}. ${chat.name} | ${chat.id}`
        );
    });

    await client.disconnect();
}

main().catch((error) => {
    console.error("\nFailed:");
    console.error(error);
});