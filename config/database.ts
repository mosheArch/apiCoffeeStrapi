export default ({ env }) => ({
  connection: {
    client: env('DATABASE_CLIENT'),
    connection: {
      host: env('DATABASE_HOST'),
      port: env.int('DATABASE_PORT'),
      database: env('DATABASE_NAME'),
      user: env('DATABASE_USERNAME'),
      password: env('DATABASE_PASSWORD'),
      ssl: env.bool('DATABASE_SSL') && {
        rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED'),
      },
      schema: env('DATABASE_SCHEMA'),
    },
    debug: env.bool('DATABASE_DEBUG'),
    pool: {
      min: env.int('DATABASE_POOL_MIN'),
      max: env.int('DATABASE_POOL_MAX'),
    },
  },
});