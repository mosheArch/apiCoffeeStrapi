export default ({ env }) => ({
    upload: {
        config: {
            provider: 'aws-s3',
            providerOptions: {
                accessKeyId: env('AWS_ACCESS_KEY_ID'),
                secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
                region: env('AWS_REGION'),
                params: {
                    ACL: env('AWS_ACL', 'public-read'),
                    Bucket: env('AWS_BUCKET'),
                },
            },
        },
    },
});
