async function saveMessages(documents) {
    if (documents.length === 0) {
        return {
            inserted: 0,
            duplicates: 0,
        };
    }

    const operations = documents.map((document) => ({
        updateOne: {
            filter: {
                chatId: document.chatId,
                telegramId: document.telegramId,
            },

            update: {
                $setOnInsert: document,
            },

            upsert: true,
        },
    }));

    const result =
        await Message.bulkWrite(
            operations,
            {
                ordered: false,
            }
        );

    return {
        inserted:
            result.upsertedCount || 0,

        duplicates:
            documents.length -
            (result.upsertedCount || 0),
    };
}
