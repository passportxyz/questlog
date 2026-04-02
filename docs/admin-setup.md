# First-Time Admin Setup

## 1. Deploy the server

Run the Quest Log server with a PostgreSQL database. Set these environment variables:

```
QL_JWT_SECRET=<random-secret>
DATABASE_URL=postgres://user:pass@host:5432/questlog
```

## 2. Register the first user

```bash
npm install -g questlog-ai
ql init --host https://quest-log.your-org.com
ql register --name "Your Name"
```

When no admin exists, the first registration is auto-approved.

## 3. Promote yourself to admin

```bash
ql admin set <your-user-id>
```

This locks down registration — all future users will need admin approval.

## 4. Approve new users

When someone registers, they'll be pending until you approve them:

```bash
ql admin list-pending          # see who's waiting
ql admin approve <user_id>     # approve a user
```

## Admin commands

```
ql admin set <user_id>              # promote to admin (first call bootstraps)
ql admin step-down                  # revoke your own admin status
ql admin approve <user_id>          # approve a pending user
ql admin list-pending               # list users awaiting approval
ql admin revoke-key <user_id>       # revoke all keys for a user
ql admin delete-user <user_id>      # delete a user (must have no tasks)
ql admin add-webhook --url <url> --events created,completed
ql admin webhooks                   # list webhooks
ql admin delete-webhook <id>        # delete a webhook
```
