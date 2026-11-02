# SQL migrations

`../schema.sql` is the v5 baseline. Add each schema change as `v6_<description>.sql`, then v7 and so on, and register it in `MIGRATIONS` in `../migrations.ts`.

Released SQL files are immutable. Transactions, schema history and `user_version` are managed by the migration runner. Do not put transaction control or connection pragmas in migration SQL.
