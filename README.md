# Chat - Ask Support

A lightweight, production-ready **support chat widget**.

- **Frontend**: static `index.html` + `chat.js` + `chat.css` (deploy to **GitHub Pages**)
- **Backend**: **Flask** API (`app.py`) running on **Render** behind **Gunicorn**
- **Storage**: **PostgreSQL** (Render Postgres) via `psycopg`

## What you get

- Floating chat widget UI (embed anywhere)
- Polling-based realtime-ish chat updates
- File attachments (`.png`, `.jpg`, `.jpeg`, `.pdf`)
- Simple API that can be consumed by any static site
- CORS configured for GitHub Pages (origin allowlist)

---

## Repo layout

- `app.py` - Flask API server
- `requirements.txt` - Python dependencies (includes `gunicorn`)
- `Procfile` - Render/Gunicorn start command
- `index.html` - demo/host page for the widget
- `chat.js` - widget logic
- `chat.css` - widget styles

---

## Backend (Flask API)

### Endpoints

- `GET /healthz`
  - Health check.

- `GET /api/messages?user_identifier=USER123&after_id=0`
  - Returns messages for a user after a given message id.

- `POST /api/messages` (multipart/form-data)
  - Fields:
    - `user_identifier` (string, required)
    - `message` (string, optional if a file is provided)
    - `file` (optional; `.png`, `.jpg`, `.jpeg`, `.pdf`)

- `GET /api/messages/<id>/file?user_identifier=USER123`
  - Downloads attachment for a specific message id (scoped by `user_identifier`).

---

## Configuration

### Required environment variables (backend)

- `DATABASE_URL`
  - Your Postgres connection string.

### CORS environment variables (backend)

This project uses an **origin allowlist** driven by env vars.

- `CHAT_CORS_ALLOW_ORIGINS`
  - Comma-separated list of allowed origins.
  - Example (GitHub Pages):
    - `https://<your-github-username>.github.io`
    - `https://<your-github-username>.github.io,<https://your-custom-domain.com>`

Optional:

- `CHAT_CORS_ALLOW_HEADERS` (default: `Content-Type`)
- `CHAT_CORS_ALLOW_METHODS` (default: `GET,POST,OPTIONS`)
- `CHAT_CORS_MAX_AGE` (default: `86400`)
- `CHAT_CORS_ALLOW_CREDENTIALS` (default: disabled)

Important notes:

- If `CHAT_CORS_ALLOW_ORIGINS` is **not** set, the API will respond with `Access-Control-Allow-Origin: *`.
- If `CHAT_CORS_ALLOW_CREDENTIALS=true`, you must use an explicit origin allowlist (no `*`).

---

## Local development

### 1) Create and activate a virtual environment

```bash
python -m venv .venv
source .venv/bin/activate
```

### 2) Install dependencies

```bash
pip install -r requirements.txt
```

### 3) Set environment variables

```bash
export DATABASE_URL='postgresql://...'
export FLASK_DEBUG=true
export CHAT_CORS_ALLOW_ORIGINS='http://localhost:3000,http://localhost:5500'
```

### 4) Run the API

```bash
python app.py
```

By default the API listens on `http://localhost:5001`.

### 5) Run the frontend locally

Serve the folder using any static server (examples):

- VS Code “Live Server”
- `python -m http.server 5500`

---

## Production deployment

### A) Deploy backend to Render (Gunicorn)

1. Push this repository to GitHub.
2. In Render:
   - Create a new **Web Service**
   - Connect your repo
   - Environment: **Python**
3. Render will use the `Procfile`:

```text
web: gunicorn --bind 0.0.0.0:$PORT --workers 2 --threads 8 --timeout 120 app:app
```

4. Add environment variables in Render:
   - `DATABASE_URL` (from your Render Postgres instance)
   - `CHAT_CORS_ALLOW_ORIGINS` (your GitHub Pages origin)

Example:

```text
CHAT_CORS_ALLOW_ORIGINS=https://<your-github-username>.github.io
```

5. Deploy.

Once live, you’ll have a backend URL like:

```text
https://your-service.onrender.com
```

### B) Deploy frontend to GitHub Pages

You can deploy the static files (`index.html`, `chat.js`, `chat.css`) to GitHub Pages.

Then set your API base URL in **one** of two supported ways:

#### Option 1: Set `window.CHAT_API_BASE` (recommended)

In `index.html`, before loading `chat.js`:

```html
<script>
  window.CHAT_API_BASE = 'https://your-service.onrender.com';
</script>
<script src="chat.js"></script>
```

#### Option 2: Use a `data-api-base` attribute

```html
<div id="chat-widget" data-api-base="https://your-service.onrender.com">
  ...
</div>
```

---

## Database

The backend expects a `messages` table with:

- `id` (integer, primary key)
- `user_identifier` (text)
- `sender` (text: `user` / `admin`)
- `admin_name` (text, nullable)
- `message` (text)
- `file` (bytea, nullable)
- `created_at` (timestamp)

If you want, tell me what Postgres provider/version you’re using and I can add a migration/DDL script.

---

## Security / production notes

- Do not commit `.env` with real credentials.
- Configure `CHAT_CORS_ALLOW_ORIGINS` to only your known frontends.
- For larger files or high traffic, store uploads in object storage (S3/GCS) instead of Postgres bytea.

---

## Troubleshooting

### CORS errors in browser console

- Confirm `CHAT_CORS_ALLOW_ORIGINS` exactly matches your GitHub Pages origin:
  - Must include `https://`
  - No trailing slash

### Frontend still calling localhost

- Confirm you set `window.CHAT_API_BASE` (or `data-api-base`) on the GitHub Pages site.

### Render deploy succeeds but API errors

- Confirm `DATABASE_URL` is set in Render.
- Check Render logs for connection or schema issues.

---

## License

Add a license if you plan to distribute this publicly.
