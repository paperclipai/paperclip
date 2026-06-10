"""Clerk webhook routes for Toca Ficha Dr. cloud API (v3.0.4).

Listens for Clerk dashboard events (user.created / user.updated /
user.deleted / session.created) so the User table stays in sync with
Clerk's user lifecycle. Webhook signing uses Svix (Clerk's webhook
provider) — `CLERK_WEBHOOK_SECRET` env var or `pedbot-clerk-webhook-secret`
Keychain entry holds the signing key.

Stripe customer linkage:
- user.created: a Stripe customer is NOT created eagerly. The existing
  `billing.create_checkout_session` flow lazily creates the customer
  on first paid checkout. This minimizes Stripe API calls and matches
  the strategy memo decision (Option A — keep existing Stripe code).
- user.deleted: any active subscription is cancelled (best-effort).

Related artifacts:
- Phase plan: tocafichadr-extension/.planning/phases/002-clerk-migration/PLAN.md
- Strategy memo: tocafichadr-extension/docs/STRATEGY-saas.md
"""
from datetime import datetime, timezone
import os
import json
import logging
from flask import Blueprint, request, jsonify

from keychain_helper import keychain_secret
from emr_automation.webhooks import _acquire_webhook_lock, _log_webhook_event

logger = logging.getLogger(__name__)

clerk_bp = Blueprint("clerk", __name__)


def _get_webhook_secret():
    """Resolve the Clerk webhook signing secret. Env first, then Keychain."""
    secret = os.environ.get("CLERK_WEBHOOK_SECRET", "").strip()
    if secret:
        return secret
    try:
        return keychain_secret("pedbot-clerk-webhook-secret")
    except SystemExit:
        return None


def _verify_signature(payload_bytes, headers):
    """Verify the Svix signature on a Clerk webhook payload.

    Returns the parsed event dict on success, None on failure.
    """
    secret = _get_webhook_secret()
    if not secret:
        logger.error("clerk webhook: CLERK_WEBHOOK_SECRET not configured")
        return None
    try:
        from svix.webhooks import Webhook, WebhookVerificationError
    except ImportError:
        logger.error("clerk webhook: svix package not installed; run `pip install svix`")
        return None
    try:
        wh = Webhook(secret)
        # Svix expects the raw payload string + the svix-id / svix-timestamp / svix-signature headers.
        return wh.verify(payload_bytes, dict(headers))
    except Exception as e:
        logger.warning("clerk webhook: signature verification failed: %s", e)
        return None


def _handle_user_created(event_data):
    """Ensure a User row exists with the Clerk user_id. Idempotent — auth.py's
    lazy provisioning may have already created the row on the user's first
    authenticated request, so we either no-op or fill in fields that arrived
    too early at lazy-provision time (e.g., name, primary_email)."""
    from emr_automation.database import get_session
    from emr_automation.models import User
    from sqlalchemy.exc import IntegrityError

    clerk_user_id = event_data.get("id")
    if not clerk_user_id:
        return False
    primary_email = None
    for em in (event_data.get("email_addresses") or []):
        if em.get("id") == event_data.get("primary_email_address_id"):
            primary_email = em.get("email_address")
            break
    if not primary_email:
        # Fallback: take the first email if primary_email_address_id is missing.
        emails = event_data.get("email_addresses") or []
        if emails:
            primary_email = emails[0].get("email_address")
    name = " ".join(filter(None, [event_data.get("first_name"), event_data.get("last_name")])).strip() or None

    session_db = get_session()
    user = session_db.query(User).filter_by(clerk_user_id=clerk_user_id).first()
    if user is None:
        user = User(
            clerk_user_id=clerk_user_id,
            email=primary_email or f"{clerk_user_id}@unknown.local",
            name=name,
            plan="free",
            password_hash="",  # Clerk owns password storage; vestigial column dropped in v3.0.4 future.
            trial_ends_at=User.default_trial_end(),
        )
        session_db.add(user)
        try:
            session_db.commit()
            logger.info("clerk webhook user.created: provisioned User id=%s clerk_user_id=%s",
                        user.id, clerk_user_id)
            return True
        except IntegrityError:
            # Bug 74 (sibling of Bug 73): auth.py's lazy-provisioning OR a concurrent
            # Clerk webhook redelivery (Svix is at-least-once) already inserted this
            # clerk_user_id (UNIQUE). Roll back so the thread-local scoped session
            # isn't left poisoned, adopt the winner, and fall through to fill any
            # fresher fields below.
            session_db.rollback()
            user = session_db.query(User).filter_by(clerk_user_id=clerk_user_id).first()
            if user is None:
                return False
    # Update email/name if Clerk supplies fresher values than what auth.py captured
    # at lazy-provision (reached for a pre-existing row OR a race-adopted one).
    changed = False
    if primary_email and user.email != primary_email and not user.email.endswith("@unknown.local"):
        # Don't overwrite a real email with one Clerk thinks is canonical — only fill in if our placeholder.
        pass
    elif primary_email and user.email != primary_email:
        user.email = primary_email
        changed = True
    if name and user.name != name:
        user.name = name
        changed = True
    if changed:
        session_db.commit()
        logger.info("clerk webhook user.created: updated User id=%s", user.id)
    return True


def _handle_user_updated(event_data):
    """Sync email/name changes from Clerk → User row."""
    from emr_automation.database import get_session
    from emr_automation.models import User

    clerk_user_id = event_data.get("id")
    if not clerk_user_id:
        return False
    primary_email = None
    for em in (event_data.get("email_addresses") or []):
        if em.get("id") == event_data.get("primary_email_address_id"):
            primary_email = em.get("email_address")
            break
    name = " ".join(filter(None, [event_data.get("first_name"), event_data.get("last_name")])).strip() or None

    session_db = get_session()
    user = session_db.query(User).filter_by(clerk_user_id=clerk_user_id).first()
    if user is None:
        # Webhook arrived before the user ever authenticated — provision now.
        return _handle_user_created(event_data)
    changed = False
    if primary_email and user.email != primary_email:
        user.email = primary_email
        changed = True
    if name and user.name != name:
        user.name = name
        changed = True
    if changed:
        session_db.commit()
        logger.info("clerk webhook user.updated: User id=%s", user.id)
    return True


def _handle_user_deleted(event_data):
    """Delete the User row + cancel any active Stripe subscription (best-effort)."""
    from emr_automation.database import get_session
    from emr_automation.models import User, Subscription

    clerk_user_id = event_data.get("id")
    if not clerk_user_id:
        return False

    session_db = get_session()
    user = session_db.query(User).filter_by(clerk_user_id=clerk_user_id).first()
    if user is None:
        # Already gone or never existed — idempotent success.
        return True

    # Best-effort Stripe subscription cancellation.
    if user.stripe_customer_id:
        try:
            from emr_automation.billing import _get_stripe
            s = _get_stripe()
            subs = s.Subscription.list(customer=user.stripe_customer_id, status="active", limit=10)
            for sub in subs.auto_paging_iter():
                try:
                    s.Subscription.delete(sub.id)
                    logger.info("clerk webhook user.deleted: cancelled Stripe sub %s", sub.id)
                except Exception as e:
                    logger.warning("clerk webhook user.deleted: failed cancel sub %s: %s", sub.id, e)
        except Exception as e:
            logger.warning("clerk webhook user.deleted: Stripe cleanup failed for %s: %s",
                           clerk_user_id, e)

    # Clear FKs: subscriptions/usage_logs/audit_trail rows — drop them so the User delete
    # doesn't fail on FK constraints. Keep audit_trail for compliance? Yes, but null the FK.
    try:
        from emr_automation.models import UsageLog, AuditTrail
        session_db.query(Subscription).filter_by(user_id=user.id).delete()
        session_db.query(UsageLog).filter_by(user_id=user.id).delete()
        # AuditTrail rows: null the user_id (preserve compliance log) instead of delete.
        session_db.query(AuditTrail).filter_by(user_id=user.id).update({AuditTrail.user_id: None})
    except Exception as e:
        logger.warning("clerk webhook user.deleted: FK cleanup partial: %s", e)

    session_db.delete(user)
    session_db.commit()
    logger.info("clerk webhook user.deleted: removed User id=%s clerk_user_id=%s",
                user.id, clerk_user_id)
    return True


@clerk_bp.route("/clerk/webhook", methods=["POST"])
def clerk_webhook():
    """Handle Clerk webhook events.

    No auth decorator — Svix signature is the authentication.
    Returns 200 on success or for ignored event types (Clerk retries on 4xx/5xx).
    """
    payload_bytes = request.get_data()
    headers = dict(request.headers)

    event = _verify_signature(payload_bytes, headers)
    if event is None:
        return jsonify({"error": "Invalid signature or unconfigured webhook"}), 401

    event_type = event.get("type", "")
    event_data = event.get("data") or {}
    external_id = event.get("id")

    from emr_automation.database import get_session
    session_db = get_session()

    # CHRA-1870: Atomic idempotency guard. Try to insert a "processing" row.
    lock_record, is_new = _acquire_webhook_lock(
        session_db, external_id, "clerk", event_type, event
    )
    if not is_new:
        if lock_record and lock_record.status in ("processed", "failed", "ignored"):
            return jsonify({"received": True, "type": event_type, "idempotent": True}), 200
        # Another worker is currently processing this event.
        return jsonify({"received": True, "type": event_type, "concurrent": True}), 200

    try:
        if event_type == "user.created":
            _handle_user_created(event_data)
        elif event_type == "user.updated":
            _handle_user_updated(event_data)
        elif event_type == "user.deleted":
            _handle_user_deleted(event_data)
        else:
            # Ignored events (session.created, organization.*, etc.) — return 200 so Clerk doesn't retry.
            logger.debug("clerk webhook: ignored event type %s", event_type)
            if lock_record:
                lock_record.status = "ignored"
                lock_record.http_status = 200
                lock_record.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                session_db.commit()
            else:
                _log_webhook_event("clerk", event_type, event, status="ignored", http_status=200)
            return jsonify({"received": True, "type": event_type}), 200

        # Success path — update lock record to "processed".
        if lock_record:
            lock_record.status = "processed"
            lock_record.http_status = 200
            lock_record.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            session_db.commit()
        else:
            _log_webhook_event("clerk", event_type, event, status="processed", http_status=200)

        return jsonify({"received": True, "type": event_type}), 200
    except Exception as e:
        logger.exception("clerk webhook: handler error for %s: %s", event_type, e)
        # Rollback any dirty scoped session so the failure update can commit cleanly.
        try:
            session_db.rollback()
        except Exception:
            pass
        if lock_record:
            lock_record.status = "failed"
            lock_record.http_status = 500
            lock_record.error_message = str(e)
            lock_record.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            try:
                session_db.commit()
            except Exception as inner:
                logger.warning("Failed to update webhook lock record to failed: %s", inner)
        else:
            _log_webhook_event("clerk", event_type, event, status="failed", http_status=500, error_message=str(e))
        # 500 → Clerk will retry. Use 200 + log error if you want to suppress retries.
        return jsonify({"error": "handler exception"}), 500
