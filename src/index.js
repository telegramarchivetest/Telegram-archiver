require("dotenv").config();

const { spawn } = require("child_process");
const path = require("path");


const steps = [
    {
        name: "Archive Chats",
        file: "archive-chats.js",
    },
    {
        name: "Archive Messages",
        file: "archive-messages.js",
    },
    {
        name: "Archive Media",
        file: "archive-media.js",
    },
];


function runStep(step) {
    return new Promise((resolve, reject) => {
        console.log("\n");
        console.log("========================================");
        console.log(step.name);
        console.log("========================================\n");


        const filePath =
            path.join(
                __dirname,
                step.file
            );


        const child =
            spawn(
                process.execPath,
                [filePath],
                {
                    stdio: "inherit",
                    env: process.env,
                }
            );


        child.on(
            "error",
            (error) => {
                reject(error);
            }
        );


        child.on(
            "close",
            (code) => {
                if (code === 0) {
                    console.log(
                        `\n${step.name} completed successfully.`
                    );

                    resolve();
                    return;
                }


                reject(
                    new Error(
                        `${step.name} failed with exit code ${code}`
                    )
                );
            }
        );
    });
}


async function main() {
    console.log("\n");
    console.log("========================================");
    console.log("TELEGRAM ARCHIVER");
    console.log("========================================");
    console.log("Starting archive pipeline...");
    console.log("\n");


    try {
        for (const step of steps) {
            await runStep(step);
        }


        console.log("\n");
        console.log("========================================");
        console.log("ARCHIVE PIPELINE COMPLETED");
        console.log("========================================");
        console.log(
            "Chats, messages and media have been processed."
        );
        console.log("\n");


        process.exit(0);

    } catch (error) {
        console.error("\n");
        console.error("========================================");
        console.error("ARCHIVE PIPELINE FAILED");
        console.error("========================================");
        console.error(error.message);
        console.error("\n");


        process.exit(1);
    }
}


process.on(
    "SIGTERM",
    () => {
        console.log(
            "\nReceived SIGTERM. Shutting down..."
        );

        process.exit(0);
    }
);


process.on(
    "SIGINT",
    () => {
        console.log(
            "\nReceived SIGINT. Shutting down..."
        );

        process.exit(0);
    }
);


main();