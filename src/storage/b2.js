require("dotenv").config();

const {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const {
    Upload,
} = require("@aws-sdk/lib-storage");

const fs =
    require("fs");


/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const s3 =
    new S3Client({
        endpoint:
        process.env.B2_ENDPOINT,

        region:
        process.env.B2_REGION,

        credentials: {
            accessKeyId:
            process.env.B2_KEY_ID,

            secretAccessKey:
            process.env.B2_APPLICATION_KEY,
        },

        /*
         * Keep connections alive.
         *
         * This is useful when uploading
         * many files sequentially/concurrently.
         */
        requestHandler: undefined,
    });


const bucketName =
    process.env.B2_BUCKET_NAME;


/*
|--------------------------------------------------------------------------
| Upload configuration
|--------------------------------------------------------------------------
*/

const MULTIPART_PART_SIZE =
    8 * 1024 * 1024;


/*
 * Number of parts uploaded concurrently
 * for a single large file.
 */
const MULTIPART_QUEUE_SIZE =
    4;


/*
|--------------------------------------------------------------------------
| Upload normal body
|--------------------------------------------------------------------------
*/

async function uploadFile({
                              key,
                              body,
                              contentType,
                              size,
                          }) {
    const command =
        new PutObjectCommand({
            Bucket:
            bucketName,

            Key:
            key,

            Body:
            body,

            ContentType:
            contentType,

            ...(size != null && {
                ContentLength:
                size,
            }),
        });


    await s3.send(
        command
    );


    return key;
}


/*
|--------------------------------------------------------------------------
| Upload file from path
|--------------------------------------------------------------------------
*/

async function uploadFileFromPath({
                                      key,
                                      filePath,
                                      contentType,
                                      size,
                                  }) {
    const fileStream =
        fs.createReadStream(
            filePath
        );


    /*
     * Multipart Upload.
     *
     * Large files are divided into parts
     * and several parts can be uploaded
     * concurrently.
     */
    const upload =
        new Upload({
            client:
            s3,

            params: {
                Bucket:
                bucketName,

                Key:
                key,

                Body:
                fileStream,

                ContentType:
                contentType,

                ...(size != null && {
                    ContentLength:
                    size,
                }),
            },

            partSize:
            MULTIPART_PART_SIZE,

            queueSize:
            MULTIPART_QUEUE_SIZE,

            leavePartsOnError:
                false,
        });


    await upload.done();


    return key;
}


/*
|--------------------------------------------------------------------------
| Delete file
|--------------------------------------------------------------------------
*/

async function deleteFile(
    key
) {
    const command =
        new DeleteObjectCommand({
            Bucket:
            bucketName,

            Key:
            key,
        });


    await s3.send(
        command
    );
}


module.exports = {
    uploadFile,
    uploadFileFromPath,
    deleteFile,
};