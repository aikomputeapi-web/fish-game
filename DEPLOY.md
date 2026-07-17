# Deploy to Render + Neon (Free Tier)

Step-by-step guide to host Reef Fortune for free using Render (web service)
and Neon (Postgres database).

---

## Prerequisites

- A [GitHub](https://github.com) account
- A [Render](https://render.com) account (free tier)
- A [Neon](https://neon.tech) account (free tier)
- Git installed locally

---

## Step 1: Push to GitHub

```bash
cd fire-kirin-dev
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/fire-kirin-dev.git
git branch -M main
git push -u origin main
```

## Step 2: Create a Neon Database

1. Sign in to [neon.tech](https://neon.tech).
2. Click **Create Project**.
3. Choose a project name (e.g. `firekirin-db`) and a region close to Oregon
   (Render's default region).
4. On the project dashboard, find the **Connection string** under
   **Connection Details**. It looks like:
   ```
   postgresql://neondb_owner:xxxx@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
5. Copy this string — you'll need it in Step 4.

## Step 3: Connect the Repo to Render

1. Sign in to [render.com](https://render.com).
2. Click **New +** → **Web Service**.
3. Connect your GitHub repo (`fire-kirin-dev`).
4. Render will detect `render.yaml` and auto-fill most settings. Verify:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

## Step 4: Set Environment Variables

In the Render dashboard, go to **Environment** and set these variables:

| Key | Value |
|---|---|
| `DATABASE_URL` | Paste the Neon connection string from Step 2 |
| `JWT_SECRET` | Click **Generate** (or enter a long random string) |
| `ADMIN_USERNAME` | Choose your owner username (e.g. `admin`) |
| `ADMIN_PASSWORD` | Choose a strong password |
| `SIGNUP_BONUS` | `2000` (or your preferred starting balance) |

> **Important**: `DATABASE_URL` must include `?sslmode=require` at the end.
> Neon requires SSL connections.

## Step 5: Deploy

1. Click **Create Web Service**.
2. Render will build and deploy automatically. Wait for the deploy to succeed.
3. Your game is live at `https://fire-kirin-dev.onrender.com` (or whatever
   name you chose).

## Step 6: First Login

1. Open your Render URL.
2. Go to `/auth.html`.
3. Log in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` you set in Step 4.
4. This is the **Owner** account — you have full control.

---

## Manager Flow

From the Owner account, you can promote players to Manager via the Admin
panel (`/admin.html`):

1. Have someone register as a player (via `/auth.html`).
2. In the Admin panel, find the user and click **Promote to Manager**.
3. The manager logs in and sees the Manager Dashboard (`/manager.html`).
4. The manager can grant funds to claimed players and approve redemption
   requests.

---

## Troubleshooting

### Render service sleeps after inactivity

Free-tier Render services sleep after 15 minutes of inactivity. The first
request after sleep takes ~30 seconds to wake up. This is normal on the free
plan.

### Database connection errors

- Ensure `DATABASE_URL` includes `?sslmode=require`.
- Check that Neon's IP allowlist includes Render's IPs (Neon defaults to
  allow all IPs).

### Port issues

Render assigns the port via the `PORT` environment variable automatically.
The app reads `process.env.PORT` and falls back to 3001 locally. No
configuration needed.

### Reset the database

In Neon's dashboard, go to your project → **Tables** and truncate or drop
tables. On next boot, migrations will recreate the schema and re-seed the
owner account.

---

## Updating

Push to `main` and Render auto-deploys:

```bash
git add .
git commit -m "Description of changes"
git push
```

Check the Render dashboard **Events** tab for deploy status.
