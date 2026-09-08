const { getTelegramClient } = require("./telegram");

// چند روز اخیر
const ARCHIVE_DAYS = 1;

// تعداد پیام در هر درخواست
const BATCH_SIZE = 100;

async function main() {
    const client = await getTelegramClient();

    /*
     * گرفتن اطلاعات اکانت خودمان
     */

    const me = await client.getMe();

    const myId = me.id.toString();

    console.log(`My Telegram ID: ${myId}\n`);

    /*
     * گرفتن Dialogها
     */

    const dialogs = await client.getDialogs({});

    /*
     * فقط Private Chat
     *
     * و حذف چت با خودمان
     */

    const privateChats = dialogs.filter((dialog) => {
        const entity = dialog.entity;

        if (!entity) {
            return false;
        }

        if (entity.className !== "User") {
            return false;
        }

        // حذف Saved Messages / چت با خودمان
        if (entity.id?.toString() === myId) {
            return false;
        }

        return true;
    });

    if (privateChats.length === 0) {
        console.log("No private chats found.");

        await client.disconnect();

        return;
    }

    /*
     * فعلاً اولین Private Chat واقعی
     */

    const dialog = privateChats[0];

    const user = dialog.entity;

    const chatName =
        `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
        user.username ||
        "Unknown";

    console.log(`Selected chat: ${chatName}`);

    console.log(`Chat ID: ${user.id.toString()}\n`);

    /*
     * محاسبه تاریخ شروع آرشیو
     */

    const endDate = new Date();

    const startDate = new Date();

    startDate.setDate(
        startDate.getDate() - ARCHIVE_DAYS
    );

    console.log(
        `Archive from: ${startDate.toISOString()}`
    );

    console.log(
        `Archive until: ${endDate.toISOString()}\n`
    );

    /*
     * Timestamp
     */

    const startTimestamp = Math.floor(
        startDate.getTime() / 1000
    );

    /*
     * Pagination
     */

    let offsetId = 0;

    let totalMessages = 0;

    let page = 1;

    const archivedMessages = [];

    while (true) {
        console.log(
            `Fetching page ${page}...`
        );

        const messages =
            await client.getMessages(
                user,
                {
                    limit: BATCH_SIZE,

                    ...(offsetId > 0 && {
                        offsetId,
                    }),
                }
            );

        if (!messages.length) {
            console.log(
                "No more messages."
            );

            break;
        }

        console.log(
            `Received ${messages.length} messages`
        );

        /*
         * بررسی پیام‌ها
         */

        for (const message of messages) {
            if (!message.id || !message.date) {
                continue;
            }

            const messageTimestamp =
                message.date;

            /*
             * چون پیام‌ها از جدید به قدیم
             * برمی‌گردند، وقتی به قبل از
             * تاریخ شروع رسیدیم، می‌توانیم
             * کل loop را متوقف کنیم.
             */

            if (
                messageTimestamp <
                startTimestamp
            ) {
                break;
            }

            /*
             * پیام داخل بازه زمانی
             */

            archivedMessages.push({
                id: message.id,

                text:
                    message.message || "",

                date: new Date(
                    message.date * 1000
                ).toISOString(),

                outgoing:
                    Boolean(message.out),

                senderId:
                    message.senderId
                        ? message.senderId.toString()
                        : null,

                hasMedia:
                    Boolean(message.media),

                mediaType:
                    message.photo
                        ? "photo"
                        : message.video
                        ? "video"
                        : message.voice
                        ? "voice"
                        : null,
            });

            totalMessages++;
        }

        /*
         * قدیمی‌ترین پیام این Batch
         */

        const oldestMessage =
            messages[messages.length - 1];

        if (
            !oldestMessage ||
            !oldestMessage.id
        ) {
            break;
        }

        /*
         * اگر قدیمی‌ترین پیام
         * از تاریخ شروع قدیمی‌تر است،
         * کار تمام شده.
         */

        if (
            oldestMessage.date &&
            oldestMessage.date <
                startTimestamp
        ) {
            console.log(
                "\nReached archive start date."
            );

            break;
        }

        /*
         * برای گرفتن Batch بعدی
         */

        offsetId =
            oldestMessage.id;

        page++;

        /*
         * جلوگیری از حلقه بی‌نهایت
         */

        if (messages.length < BATCH_SIZE) {
            break;
        }
    }

    console.log(
        `\nTotal archived messages: ${totalMessages}\n`
    );

    /*
     * نمایش پیام‌ها
     */

    archivedMessages.forEach(
        (message) => {
            console.log(message);
        }
    );

    await client.disconnect();
}

main().catch((error) => {
    console.error(
        "\nFailed:"
    );

    console.error(error);
});
