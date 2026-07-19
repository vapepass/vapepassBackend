# VapePass Backend API

Node.js / Express REST API for the VapePass digital loyalty card platform.

## Prerequisites

- **Node.js** 18+
- **MongoDB** running locally or a MongoDB Atlas connection string

## Quick Start

```bash
cd backend
npm install
```

Copy environment variables (already provided in `.env`) and update as needed:

```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/vapepass
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES=15m
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-in-production
JWT_REFRESH_EXPIRES=7d
CLIENT_URL=http://localhost:3000
```

Start the server:

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

- API base URL: `http://localhost:5000/api/v1`
- Swagger docs: `http://localhost:5000/api-docs`
- Health check: `http://localhost:5000/health`

## Testing

```bash
npm test
```

Covers auth flows, tenant isolation, employee invites, Stripe status mapping, webhook idempotency, BC compliance, and the AI Assistant.

## VapePass Assistant

AI chatbot widget that recommends products only from each store's live MongoDB inventory, with hardcoded BC compliance.

### Environment

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
SCRAPINGBEE_API_KEY=
CRON_SECRET=change-me-cron-secret
API_PUBLIC_URL=http://localhost:5000
ENABLE_INTERNAL_CRON=false
```

### Onboarding flow

1. Store submits product page URL (setup or **AI Assistant** dashboard page)
2. Scraper (ScrapingBee, Playwright fallback) syncs inventory to MongoDB
3. Store copies one-line embed code onto their website
4. Daily cron refreshes inventory (`POST /api/v1/cron/sync-inventory` with `CRON_SECRET`)

### Embed code

```html
<script src="https://YOUR_API_HOST/widget.js" data-store-id="STORE_ID" async></script>
```

Optional: set `data-require-site-age="true"` to keep the widget hidden until the host site sets `localStorage.vapepass_site_age_verified = "true"` (or `age_verified`).

## API Overview

### Authentication (`/api/v1/auth`)

| Method | Endpoint           | Auth     | Description                    |
|--------|--------------------|----------|--------------------------------|
| POST   | `/register`        | Public   | Register store owner + store   |
| POST   | `/login`           | Public   | Login, returns access token    |
| POST   | `/logout`          | Required | Clear refresh token            |
| POST   | `/forgot-password` | Public   | Request password reset         |
| POST   | `/reset-password`  | Public   | Reset password with token      |
| POST   | `/refresh`         | Public   | Refresh access token (cookie)  |
| GET    | `/profile`         | Required | Get current user profile       |

### Store (`/api/v1/store`)

| Method | Endpoint              | Auth              | Description              |
|--------|-----------------------|-------------------|--------------------------|
| GET    | `/`                   | Required          | Get user's store         |
| PUT    | `/settings`           | Store owner only  | Update store settings    |
| GET    | `/employees`          | Store owner only  | List store employees     |
| POST   | `/employees`          | Store owner only  | Invite employee account  |
| DELETE | `/employees/:id`      | Store owner only  | Deactivate employee      |

### Billing (`/api/v1/billing`)

| Method | Endpoint    | Auth              | Description                    |
|--------|-------------|-------------------|--------------------------------|
| GET    | `/`         | Store owner only  | Get plan info ($99/month)      |
| POST   | `/checkout` | Store owner only  | Create Stripe Checkout session |
| POST   | `/portal`   | Store owner only  | Open Stripe Customer Portal    |

### Assistant (`/api/v1/assistant`)

| Method | Endpoint              | Auth             | Description                          |
|--------|-----------------------|------------------|--------------------------------------|
| GET    | `/widget/:storeId`    | Public           | Widget bootstrap config              |
| POST   | `/session`            | Public           | Start/resume chat session            |
| POST   | `/chat`               | Public           | Send customer message                |
| GET    | `/status`             | Required         | Embed code + sync status             |
| PUT    | `/product-url`        | Store owner only | Set product page URL + sync          |
| POST   | `/sync`               | Store owner only | Manual inventory sync                |
| GET    | `/inventory`          | Required         | List synced products                 |

### Cron (`/api/v1/cron`)

| Method | Endpoint            | Auth         | Description                    |
|--------|---------------------|--------------|--------------------------------|
| POST   | `/sync-inventory`   | Cron secret  | Daily inventory sync all stores|

### Webhooks

| Method | Endpoint                    | Auth   | Description              |
|--------|-----------------------------|--------|--------------------------|
| POST   | `/api/v1/webhooks/stripe`   | Stripe | Subscription lifecycle   |

## Sample Requests (cURL)

### Register

```bash
curl -X POST http://localhost:5000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Jane",
    "lastName": "Doe",
    "email": "jane@cloudnine.com",
    "password": "SecurePass1",
    "storeName": "Cloud Nine Vapes"
  }'
```

### Login

```bash
curl -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{
    "email": "jane@cloudnine.com",
    "password": "SecurePass1"
  }'
```

Save the `accessToken` from the response for authenticated requests.

### Get Profile

```bash
curl http://localhost:5000/api/v1/auth/profile \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Update Store Settings

```bash
curl -X PUT http://localhost:5000/api/v1/store/settings \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Cloud Nine Vapes",
    "brandColor": "#6C3CE1",
    "rewardDescription": "Free e-liquid after 10 stamps",
    "stampGoal": 10
  }'
```

## Postman

Import `postman/VapePass.postman_collection.json` into Postman.

1. Run **Register** or **Login** — the collection auto-saves `accessToken`.
2. Use **Get Profile** and **Store** endpoints with the saved token.
3. In development, **Forgot Password** returns a `resetToken` in the response for testing.

## Response Format

**Success:**

```json
{
  "success": true,
  "message": "Login successful",
  "data": {}
}
```

**Error:**

```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "Please provide a valid email address" }
  ]
}
```

## Architecture

```
backend/src/
├── config/       # DB, env, Swagger, Cloudinary
├── controllers/  # Request/response handling
├── middleware/   # Auth, validation, errors, uploads
├── models/       # Mongoose schemas
├── routes/       # API route definitions
├── services/     # Business logic
├── validators/   # express-validator rules
└── utils/        # Helpers
```

## Frontend Integration

Set `CLIENT_URL` to your Next.js app URL (default `http://localhost:3000`). The API enables CORS with credentials so the frontend can send cookies for refresh tokens.

Use the `accessToken` from login/register in the `Authorization: Bearer <token>` header for protected routes.

## Cloudinary (optional)

Add credentials to `.env` to enable logo uploads on `PUT /api/v1/store/settings`:

```env
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

Without credentials, JSON-only store updates still work; logo uploads are disabled.

## Railway + Vercel Deployment

### Railway (backend)

Set these **Environment Variables** in the Railway service (`.env` is not deployed):

| Variable | Example |
|----------|---------|
| `MONGO_URI` | `mongodb+srv://user:pass@cluster.mongodb.net/vapepass` |
| `JWT_SECRET` | long random string |
| `JWT_REFRESH_SECRET` | long random string |
| `CLIENT_URL` | `https://vapepass.vercel.app` |
| `NODE_ENV` | `production` |
| `RESEND_API_KEY` | **Recommended on Railway** — from [resend.com](https://resend.com) |
| `EMAIL_FROM` | `VapePass <onboarding@resend.dev>` (test) or verified domain sender |
| `SUPPORT_ADMIN_EMAIL` | Inbox that receives Free Setup notifications |
| `SMTP_*` | Optional local fallback only — Gmail SMTP often **times out** on Railway |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Stripe recurring price ID ($99/month) |

**Email on Railway (important):**

- Gmail SMTP (`smtp.gmail.com:587`) commonly fails with **Connection timeout** from Railway. This is a host/network limitation, not a bug in your form.
- Use **Resend** (HTTPS API) instead:
  1. Create a free account at https://resend.com
  2. Create an API key
  3. On Railway set `RESEND_API_KEY=re_...`
  4. Set `EMAIL_FROM=VapePass <onboarding@resend.dev>` for testing, or a verified domain address for production
  5. Set `SUPPORT_ADMIN_EMAIL` to the admin inbox
  6. Redeploy and confirm logs show `provider=resend`
- With `onboarding@resend.dev`, Resend may only deliver to the email on your Resend account until you verify a domain.

**MongoDB Atlas:** In Network Access, allow `0.0.0.0/0` so Railway can connect.

**Stripe webhook URL:** `https://your-app.up.railway.app/api/v1/webhooks/stripe`

Subscribe to events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.

**Verify:** After deploy, open `https://your-app.up.railway.app/health` — you should see JSON, not a Railway error page.

### Vercel (frontend)

| Variable | Example |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | `https://your-app.up.railway.app/api/v1` |

No trailing slash. Must include `/api/v1`.

### CORS errors that are really a dead backend

If the browser says *"No Access-Control-Allow-Origin header"*, but visiting the API URL shows Railway's **"Application failed to respond"** page, the server is **not running**. Fix Railway deploy logs first (usually missing `MONGO_URI` or MongoDB network access), then CORS will work automatically.
