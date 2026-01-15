import os
import re
from datetime import datetime
from brevo import send_email
import tempfile
import threading

import psycopg
from psycopg.rows import dict_row
from flask import Flask, jsonify, request, send_file
from io import BytesIO


ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "pdf"}
FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _get_db_conn():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL environment variable is required")

    return psycopg.connect(database_url)


def _is_allowed_filename(filename: str) -> bool:
    if not filename or "." not in filename:
        return False
    ext = filename.rsplit(".", 1)[1].lower()
    return ext in ALLOWED_EXTENSIONS


def _safe_filename(filename: str) -> str:
    cleaned = FILENAME_SAFE_RE.sub("_", filename).strip("_")
    return cleaned or "attachment"


app = Flask(__name__)


def _parse_allowed_origins(value: str | None) -> set[str]:
    if not value:
        return set()
    parts = [p.strip() for p in value.split(",")]
    return {p for p in parts if p}


def _is_origin_allowed(origin: str, allowed_origins: set[str]) -> bool:
    if not origin:
        return False
    if origin in allowed_origins:
        return True
    for allowed in allowed_origins:
        if allowed.startswith("*."):
            suffix = allowed[1:]
            if origin.endswith(suffix):
                return True
    return False


@app.after_request
def _add_headers(resp):
    request_origin = (request.headers.get("Origin") or "").strip()
    allowed_origins = _parse_allowed_origins(os.getenv("CHAT_CORS_ALLOW_ORIGINS"))

    allow_origin = "*"
    if allowed_origins:
        if _is_origin_allowed(request_origin, allowed_origins):
            allow_origin = request_origin
            resp.headers["Vary"] = "Origin"
        else:
            allow_origin = "null"
            resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Origin"] = allow_origin

    allow_headers = os.getenv("CHAT_CORS_ALLOW_HEADERS") or "Content-Type"
    allow_methods = os.getenv("CHAT_CORS_ALLOW_METHODS") or "GET,POST,OPTIONS"

    resp.headers["Access-Control-Allow-Headers"] = allow_headers
    resp.headers["Access-Control-Allow-Methods"] = allow_methods
    resp.headers["Access-Control-Max-Age"] = os.getenv("CHAT_CORS_MAX_AGE") or "86400"

    allow_credentials = (os.getenv("CHAT_CORS_ALLOW_CREDENTIALS") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    if allow_credentials and allow_origin != "*" and allow_origin != "null":
        resp.headers["Access-Control-Allow-Credentials"] = "true"

    return resp


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


@app.route("/api/messages", methods=["GET", "OPTIONS"])
def get_messages():
    if request.method == "OPTIONS":
        return ("", 204)

    user_identifier = request.args.get("user_identifier", "").strip()
    if not user_identifier:
        return jsonify({"error": "user_identifier is required"}), 400

    after_id_raw = request.args.get("after_id", "0").strip()
    try:
        after_id = int(after_id_raw)
    except ValueError:
        return jsonify({"error": "after_id must be an integer"}), 400

    conn = _get_db_conn()
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT id, user_identifier, sender, admin_name, message,
                       CASE WHEN file IS NULL THEN FALSE ELSE TRUE END AS has_file,
                       created_at
                FROM messages
                WHERE user_identifier = %s
                  AND id > %s
                ORDER BY id ASC
                """,
                (user_identifier, after_id),
            )
            rows = cur.fetchall()

        messages = []
        for r in rows:
            created_at = r.get("created_at")
            if isinstance(created_at, datetime):
                created_at = created_at.isoformat()

            messages.append(
                {
                    "id": r["id"],
                    "user_identifier": r["user_identifier"],
                    "sender": r["sender"],
                    "admin_name": r.get("admin_name"),
                    "message": r["message"],
                    "has_file": bool(r.get("has_file")),
                    "created_at": created_at,
                }
            )

        last_id = messages[-1]["id"] if messages else after_id
        return jsonify({"messages": messages, "last_id": last_id})
    finally:
        conn.close()


def _send_email_async(user_identifier, message, file_bytes, original_filename):
    attachment_path = None

    try:
        if file_bytes and original_filename:
            tmp = tempfile.NamedTemporaryFile(delete=False)
            tmp.write(file_bytes)
            tmp.close()
            attachment_path = tmp.name

        print("Attempting email send...")
        send_email(
            to="sumitkumarbittuair@gmail.com",
            bcc=[
                "tanishaparveen032@gmail.com",
                "sanjeshtiwariair@gmail.com"
            ],
            subject=f"New message from {user_identifier}",
            html=f"""
                <h3>New Message</h3>
                <b>User:</b> {user_identifier}<br>
                <b>Message:</b><br>{message}
            """,
            attachment_path=attachment_path
        )
        print("Email sent OK")

    except Exception as e:
        print("EMAIL ERROR:", e)

    finally:
        if attachment_path:
            try:
                os.unlink(attachment_path)
            except:
                pass


def send_message_notification(user_identifier, message, file_bytes, original_filename):
    # Run email in background so Gunicorn does not block
    t = threading.Thread(
        target=_send_email_async,
        args=(user_identifier, message, file_bytes, original_filename),
        daemon=True
    )
    t.start()



@app.route("/api/messages", methods=["POST", "OPTIONS"])
def post_message():
    if request.method == "OPTIONS":
        return ("", 204)

    user_identifier = (request.form.get("user_identifier") or "").strip()
    message = (request.form.get("message") or "").strip()

    if not user_identifier:
        return jsonify({"error": "user_identifier is required"}), 400

    upload = request.files.get("file")
    file_bytes = None

    if upload and upload.filename:
        if not _is_allowed_filename(upload.filename):
            return jsonify({"error": "file type not allowed"}), 400
        file_bytes = upload.read()
        if file_bytes is None:
            file_bytes = b""

        if not message:
            message = _safe_filename(upload.filename)

    if not message:
        return jsonify({"error": "message is required"}), 400

    conn = _get_db_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO messages (user_identifier, sender, admin_name, message, file)
                VALUES (%s, 'user', NULL, %s, %s)
                RETURNING id
                """,
                (user_identifier, message, file_bytes),
            )
            new_id = cur.fetchone()[0]
        conn.commit()

        # 🔥 Send email notification
        send_message_notification(user_identifier, message, file_bytes, upload.filename if upload else None)

        return jsonify({"ok": True, "id": new_id})
    finally:
        conn.close()


@app.route("/api/messages/<int:message_id>/file", methods=["GET", "OPTIONS"])
def download_file(message_id: int):
    if request.method == "OPTIONS":
        return ("", 204)

    user_identifier = request.args.get("user_identifier", "").strip()
    if not user_identifier:
        return jsonify({"error": "user_identifier is required"}), 400

    conn = _get_db_conn()
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT id, file
                FROM messages
                WHERE id = %s AND user_identifier = %s
                """,
                (message_id, user_identifier),
            )
            row = cur.fetchone()

        if not row:
            return jsonify({"error": "not found"}), 404
        if row["file"] is None:
            return jsonify({"error": "no file"}), 404

        file_value = row["file"]
        if isinstance(file_value, memoryview):
            file_value = file_value.tobytes()
        bio = BytesIO(file_value)
        bio.seek(0)
        return send_file(
            bio,
            mimetype="application/octet-stream",
            as_attachment=True,
            download_name=f"attachment_{message_id}",
        )
    finally:
        conn.close()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    debug = (os.getenv("FLASK_DEBUG") or "").strip().lower() in {"1", "true", "yes"}
    app.run(host="0.0.0.0", port=port, debug=debug)
