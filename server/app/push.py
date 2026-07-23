from pathlib import Path
import firebase_admin
from firebase_admin import credentials, messaging
from .config import settings
from .db import pool


def init_fcm() -> bool:
    if not settings.fcm_credentials or not Path(settings.fcm_credentials).exists():
        return False
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(settings.fcm_credentials)))
    return True


def dispatch_pending(tenant_id: str) -> None:
    if not init_fcm():
        return
    with pool.connection() as conn:
        events = conn.execute(
            "SELECT event_id,title,body,recipient_login,recipient_role,post_name FROM push_events WHERE tenant_id=%s AND delivered_at IS NULL ORDER BY created_at LIMIT 100",
            (tenant_id,),
        ).fetchall()
        for event in events:
            tokens = conn.execute(
                """
                SELECT d.push_token FROM devices d JOIN users u ON u.id=d.user_id
                WHERE d.tenant_id=%s AND d.push_token IS NOT NULL
                  AND (%s IS NULL OR lower(u.login)=lower(%s))
                  AND (%s IS NULL OR u.role=%s)
                  AND (%s IS NULL OR u.post_name=%s)
                """,
                (tenant_id, event[3], event[3], event[4], event[4], event[5], event[5]),
            ).fetchall()
            if tokens:
                messaging.send_each_for_multicast(
                    messaging.MulticastMessage(
                        tokens=[t[0] for t in tokens],
                        notification=messaging.Notification(title=event[1], body=event[2]),
                        data={"eventId": event[0]},
                    )
                )
            conn.execute("UPDATE push_events SET delivered_at=now() WHERE tenant_id=%s AND event_id=%s", (tenant_id, event[0]))
        conn.commit()
