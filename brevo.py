# brevo.py
import os
import smtplib
from typing import List, Optional
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders


def send_email(
    to: str,
    subject: str,
    html: str,
    bcc: Optional[List[str]] = None,
    attachment_path: Optional[str] = None
):
    host = os.getenv("EMAIL_HOST")
    port = int(os.getenv("EMAIL_PORT", "587"))
    user = os.getenv("EMAIL_USER")
    password = os.getenv("EMAIL_PASS")
    sender = os.getenv("EMAIL_FROM")

    if not all([host, user, password, sender]):
        raise RuntimeError("Missing EMAIL_* environment variables")

    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject

    if bcc:
        msg["Bcc"] = ", ".join(bcc)

    msg.attach(MIMEText(html, "html"))

    # Optional attachment
    if attachment_path:
        if not os.path.exists(attachment_path):
            raise FileNotFoundError(f"Attachment not found: {attachment_path}")

        filename = os.path.basename(attachment_path)

        with open(attachment_path, "rb") as f:
            part = MIMEBase("application", "octet-stream")
            part.set_payload(f.read())

        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
        msg.attach(part)

    with smtplib.SMTP(host, port) as server:
        server.starttls()
        server.login(user, password)
        server.send_message(msg)
