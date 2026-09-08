require("dotenv").config();

const {
    uploadFile,
    deleteFile,
} = require("./src/storage/b2");


async function main() {
    try {
        console.log("Uploading...");

        const key =
            await uploadFile({
                key: "test/hello.txt",

                body: Buffer.from(
                    "Hello from Telegram Archiver!"
                ),

                contentType:
                    "text/plain",
            });


        console.log(
            "Uploaded:",
            key
        );


        console.log(
            "Deleting..."
        );

        await deleteFile(key);


        console.log(
            "Deleted successfully."
        );

    } catch (error) {
        console.error(
            "Storage test failed:"
        );

        console.error(error);
    }
}


main();