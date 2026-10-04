# JOKER~👺 Bot

JOKER is a WhatsApp bot backend based on the Silva MD bot codebase, customized for a Joker-themed branded deployment.

This project is designed to be hosted as a backend service and paired with a separate custom frontend for:
- session generation
- payment collection
- subscription checks
- admin dashboard

## Features

- WhatsApp bot using Baileys
- Multi-device bot ready structure
- Custom JOKER branding
- Session-based authentication
- Render-friendly Node.js deployment
- Paystack-ready SaaS architecture

## Required environment variables

Create a `.env` file or add the following variables in your hosting provider:

```env
SESSION_ID=
OWNER_NUMBER=
OWNER_NAME=JOKER
BOT_NAME=JOKER~👺
PREFIX=.
MODE=public
THEME=joker
ALIVE_IMG=https://your-image-url.com/logo.jpg
DESCRIPTION=JOKER Bot
APP_URL=https://your-domain.com
AUTO_STATUS_SEEN=true
AUTO_STATUS_REACT=true
ANTIDELETE_GROUP=true
ANTIDELETE_PRIVATE=true
ALWAYS_ONLINE=true
ANTICALL=true
ANTIVV=true
DEBUG=false
```

## Recommended hosting

For a WhatsApp bot backend, the best choice is Render.

- Backend: Render
- Frontend: Vercel or your own custom domain
- Database: PostgreSQL
- Payment: Paystack

## Run locally

```bash
npm install
cp .env.example .env
# Fill in your values
node silva.js
```

## Deploy to Render

1. Push this repo to GitHub.
2. Open Render.
3. Create a new Web Service.
4. Connect your GitHub repo.
5. Use the following settings:
   - Build command: `npm install`
   - Start command: `node silva.js`
6. Add environment variables from the list above.
7. Set `SESSION_ID` after generating it from your session page.

## SaaS workflow for your business model

This backend supports the following business setup:

- Free trial: 1 day
- Paid plan: 500 NGN/week
- Paid plan: 3000 NGN/month
- Paystack trigger to unlock access
- User session validation via backend + database
- Admin panel for user management and subscription checks

## Important note

The bot cannot connect without a valid `SESSION_ID`. The user must generate that from your session site before the bot can work.

## Admin / subscription idea

A full admin panel can be implemented around this backend with:
- users table
- subscription table
- payment logs table
- bot status table
- access expiry checks

## Support

Telegram: https://t.me/joker4449

---

JOKER Bot — built for your custom hosting platform.
