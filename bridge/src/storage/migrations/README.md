# SQL migrations

`../schema.sql` is the v4 baseline. Add each schema change as `v5_<description>.sql`, then v6 and so on, and register it in `MIGRATIONS` in `../migrations.ts`.

Released SQL files are immutable. Transactions, schema history and `user_version` are managed by the migration runner. Do not put transaction control or connection pragmas in migration SQL.
