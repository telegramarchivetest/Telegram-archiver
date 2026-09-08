require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

const envPath = path.join(process.cwd(), ".env");

const stringSession = new StringSession(
    process.env.TELEGRAM_SESSION || ""
);

const client = new TelegramClient(
    stringSession,
    apiId,
    apiHash,
    {
        connectionRetries: 10,
        requestRetries: 5,
        autoReconnect: true,
    }
);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function question(text) {
    return new Promise((resolve) => {
        rl.question(text, resolve);
    });
}

function saveSession(session) {
    let envContent = "";

    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(
            envPath,
            "utf8"
        );
    }

    const sessionLine =
        `TELEGRAM_SESSION=${session}`;

    if (
        /^TELEGRAM_SESSION=.*$/m.test(
            envContent
        )
    ) {
        envContent = envContent.replace(
            /^TELEGRAM_SESSION=.*$/m,
            sessionLine
        );
    } else {
        if (
            envContent.length > 0 &&
            !envContent.endsWith("\n")
        ) {
            envContent += "\n";
        }

        envContent += `${sessionLine}\n`;
    }

    fs.writeFileSync(
        envPath,
        envContent
    );

    console.log(
        "\nTelegram session saved."
    );
}

async function main() {
    try {
        await client.start({
            phoneNumber: async () => {
                return await question(
                    "Phone number: "
                );
            },

            phoneCode: async () => {
                return await question(
                    "Telegram code: "
                );
            },

            password: async () => {
                return await question(
                    "2FA password: "
                );
            },

            onError: (error) => {
                console.error(
                    "Telegram error:",
                    error
                );
            },
        });

        console.log(
            "\nLogin successful!"
        );

        const session =
            client.session.save();

        saveSession(session);

        const me =
            await client.getMe();

        console.log("\nAccount:");
        console.log({
            id: me.id?.toString(),
            username: me.username,
            firstName: me.firstName,
            lastName: me.lastName,
        });

        await client.disconnect();
    } catch (error) {
        console.error(
            "\nLogin failed:"
        );

        console.error(error);
    } finally {
        rl.close();
    }
}

main();